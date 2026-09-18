package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

const (
	// genTimeout bounds a single background generation. The SSE keepalive keeps
	// the browser<->backend leg alive well within Cloudflare's 100s edge timeout;
	// this bounds the backend<->Ollama leg so a stuck generation can't hang a
	// worker slot forever.
	genTimeout     = 5 * time.Minute
	subBufferSize  = 2048 // generous: a long narration stream must not fill the buffer and cause a dropped toolExec/modelCall event
	keepaliveEvery = 5 * time.Second
	// controlSendTimeout bounds the blocking send for critical control events
	// (toolExec, modelCall, questions). Short so a truly stuck client is still
	// skipped, but long enough that a healthy client briefly behind after a burst
	// of chunk events still receives the event instead of silently losing it
	// (which would hang the agent relay loop for TOOL_EXEC_TIMEOUT).
	controlSendTimeout = 2 * time.Second
	// defaultAgentJobTimeout/defaultToolExecTimeout back-stop a zero-value
	// s.cfg.agentJobTimeout/toolExecTimeout (e.g. a *server built directly in a
	// test without going through main's envDuration defaulting). Mirrors the
	// AGENT_JOB_TIMEOUT/TOOL_EXEC_TIMEOUT defaults in main.go/.env.example.
	defaultAgentJobTimeout = 30 * time.Minute
	defaultToolExecTimeout = 15 * time.Minute
)

// errJobActive means a generation job is already running for a conversation.
var errJobActive = errors.New("a generation is already running for this conversation")

// errAgentPaused is the sentinel returned by runAgentLoop when the user
// pauses an agent-mode run between steps. The worker matches it with
// errors.Is to persist a checkpoint and finalize the job as "paused" instead
// of "error". A *pausedError carries the transcript and step index at the
// pause point so the checkpoint can be written and a later resume can
// rehydrate the conversation.
var errAgentPaused = errors.New("agent run paused")

type pausedError struct {
	transcript []oaiMessage
	step       int
}

func (p *pausedError) Error() string        { return errAgentPaused.Error() }
func (p *pausedError) Is(target error) bool { return target == errAgentPaused }

// subEvent is a single event pushed to an SSE subscriber.
type subEvent struct {
	// kind is one of: chunk, phase, search, questions, tool, toolStart, thought,
	// clear, modelCall, toolExec, done, error. "modelCall" is the browser-relay
	// cue for local-model inference; "toolExec" is the browser-relay cue for local
	// file tools (the browser runs the tool via the sidecar and POSTs the
	// observation back to /tool-response); "toolStart" is the UI cue that a tool
	// is about to run so the command block opens before the result arrives. All
	// carry a JSON payload in text (except clear, which has none).
	kind string
	text string
}

// job is an in-flight (or just-finished) background generation. It is the
// source of truth for live subscribers; SQLite holds a durable copy for
// crash reconciliation and inspection. A job is removed from the manager's
// active map once it reaches a terminal state, but subscribers that already
// hold a pointer keep draining until they see the terminal event.
type job struct {
	id        string
	convID    string
	email     string
	model     string
	webSearch bool
	clarify   bool // Clarify extra was on for this generation (drives the agent loop)
	agent     bool // Agent mode: general ReAct loop over a tool registry
	// resuming marks a job enqueued by /resume: runGeneration rehydrates the
	// transcript from the agent_checkpoints row and continues on the remaining
	// step budget. resumeNote, when non-empty, is appended as a user turn.
	resuming   bool
	resumeNote string
	// supportsTools is the frontend's verdict that the selected model can emit
	// OpenAI tool_calls. The backend trusts it only for local (browser-relay)
	// models, whose Ollama it cannot introspect; server models are re-checked
	// via /api/show in supportsTools(). Drives the tool-capability guard below.
	supportsTools bool
	// feTier is the frontend-supplied capability tier (for local relay models
	// whose Ollama the backend can't introspect). Empty → medium (the default).
	// tier is the resolved tier, set once in runGeneration before the loop runs.
	feTier    agentTier
	tier      agentTier
	createdAt int64

	promptTokens     int // agent-mode: cumulative prompt tokens (observability)
	completionTokens int // agent-mode: cumulative completion tokens (observability)

	// local marks a browser-relay (local-model) job: inference runs on the
	// visitor's Ollama via the browser, so the backend emits modelCall events and
	// awaits POST /model-response instead of dialing a server host.
	local bool
	// needsBrowser is true for any job that is connection-bound: a local
	// (browser-relay) job by definition, and also a repo-bound agent run even on
	// a server model, because its file tools (apply_patch, run_command, …) are
	// relayed through the browser via toolExec. Set once at creation (before the
	// job is enqueued) and never mutated afterward, so it is safe to read without
	// j.mu. Jobs that don't need the browser stay detached and survive any SSE
	// disconnect, exactly as before; jobs that do get a grace period instead of
	// an instant cancel — see scheduleGraceCancel.
	needsBrowser bool
	// sampling carries the agent/search/clarify sampling parameters for this
	// run, set once in runGeneration before any inference round. nil for plain
	// chat (no sampling sent → Ollama Modelfile defaults). Read by browserRelay
	// via emitModelCall so local-model rounds get the same determinism steering
	// as server-model rounds. Safe to read without j.mu: set before the loops
	// run on this worker and never mutated afterward (same pattern as
	// needsBrowser/local).
	sampling *agentSampling
	// hub is this job's owner's multiplexed /api/events stream. Every emit*/
	// notify* call also publishes to it (tagged with convId+jobId) so a
	// backgrounded chat's browser relay and the sidebar/notification UI keep
	// working without a dedicated per-conversation tail. Set at creation; nil in
	// tests that construct a job directly, which is treated as "no hub".
	hub *eventHub
	// graceTimer is armed by scheduleGraceCancel when a browser-bound job's
	// connection-of-record drops. Guarded by mu.
	graceTimer *time.Timer

	mu              sync.Mutex
	status          string // queued, generating, done, error, cancelled, paused
	content         strings.Builder
	errMsg          string
	phase           string        // last phase hint (searching/answering/clarifying…): replayed on (re)connect
	searches        []searchEntry // accumulated web-search evidence: broadcast + persisted
	clarifyMeta     *clarifyMeta  // stashed clarifying question(s) when the model called ask_user: broadcast + persisted
	steps           []agentStep   // accumulated agent tool-call trace: broadcast + persisted
	thoughts        []string      // accumulated agent per-round reasoning: broadcast + persisted
	subs            map[chan subEvent]struct{}
	finished        chan struct{}      // closed when the job reaches a terminal state
	cancelFn        context.CancelFunc // set when the job starts running
	cancelRequested bool               // set by cancel(): survive a queued/unstarted job
	// pauseRequested is set by pause() for an agent-mode run. runAgentLoop
	// checks it at the top of each iteration and after each tool result and
	// returns errAgentPaused so the worker can checkpoint the transcript.
	pauseRequested bool
	// roundCancel is the current inference round's child-context cancel func,
	// installed by runAgentLoop each round. pause() calls it so pause takes
	// effect within seconds instead of waiting out an inference round; the
	// partial round is discarded. Guarded by mu.
	roundCancel context.CancelFunc
	// pausedStep is the step index at which the run was paused, read from the
	// checkpoint by handleJob so /job and /api/jobs/active can surface "paused
	// at step N". Set by the worker when it persists the checkpoint.
	pausedStep int

	// pendingRelay is set by browserRelay.Call while it awaits the browser's POST
	// /model-response for the current round. handleModelResponse claims it under
	// mu (one deliverer wins) and sends the response, then Call clears it. Nil
	// when no relay round is in flight. Local-model jobs only.
	pendingRelay chan relayResponse
	// pendingModelCall is the last modelCall awaiting a browser response. It is
	// replayed as an SSE event on (re)connect so a browser that attaches after
	// the cue fired still runs the round. Cleared once the response arrives.
	pendingModelCall *modelCallPayload
	// pendingToolExec is set by the agent loop while it awaits the browser's POST
	// /tool-response for a local file-tool call. handleToolResponse claims it
	// under mu (one deliverer wins) and sends the observation. Nil when no
	// file-tool relay round is in flight. Used for repo-bound agent runs.
	pendingToolExec chan toolExecResponse
	// pendingToolExecPayload is the last toolExec cue awaiting a browser response.
	// Replayed on (re)connect so a browser that attaches after the cue fired still
	// runs the tool. Cleared once the response arrives.
	pendingToolExecPayload *toolExecPayload
	// pendingToolStart is the tool currently mid-execution (the toolStart cue has
	// fired but the matching tool/result event has not). Replayed on (re)connect
	// so a browser that attaches mid-run reopens the running command block
	// (spinner) instead of seeing nothing until the result lands. Cleared by
	// emitTool once the tool's result step is recorded.
	pendingToolStart *toolStartPayload
}

// relayResponse is the browser's assembled inference result for one local-model
// round, delivered through the job's pendingRelay channel. content is the full
// text the browser streamed from its Ollama (may be empty); toolCalls are the
// OpenAI tool_calls it parsed (nil/empty for a plain answer or final round).
// Error, when non-empty, signals a failed localhost fetch (e.g. Ollama 403 or
// connection refused): browserRelay.Call returns it as an error so the worker
// finalizes the job as "error" (no empty assistant message persisted) instead
// of treating the turn as a successful empty answer.
type relayResponse struct {
	content   string
	toolCalls []oaiToolCall
	Error     string `json:"error,omitempty"`
}

// modelCallPayload is the SSE `modelCall` event body: the browser's cue to run
// one inference round on its own Ollama. tools is omitted for a plain-chat
// round (the frontend treats a missing tools field as "no tools").
type modelCallPayload struct {
	ConvID   string       `json:"convId"`
	JobID    string       `json:"jobId"`
	Model    string       `json:"model"`
	Messages []oaiMessage `json:"messages"`
	Tools    []oaiTool    `json:"tools,omitempty"`
	// Sampling params for agent/search/clarify rounds (nil/omitted for plain
	// chat, which stays on Ollama defaults). Forwarded to the browser's
	// localhost /v1/chat/completions call so local models get the same
	// determinism steering as server models. Pointer types so a zero value
	// (e.g. temperature 0) is sent, while unset (nil) is omitted.
	Temperature *float64 `json:"temperature,omitempty"`
	TopP        *float64 `json:"top_p,omitempty"`
	Seed        *int64   `json:"seed,omitempty"`
}

// toolExecPayload is the SSE `toolExec` event body: the browser's cue to run a
// local file tool (read_file, list_files, glob, grep, git_status) via the
// desktop sidecar against the bound repo, then POST the observation back to
// /tool-response. Mirrors modelCallPayload for the tool-execution relay.
type toolExecPayload struct {
	ConvID string `json:"convId"`
	JobID  string `json:"jobId"`
	Step   int    `json:"step"`
	Tool   string `json:"tool"`
	Args   string `json:"args"`
	Repo   string `json:"repo"`
	// Branch is the conversation's bound branch (conversations.repo_branch),
	// sourced fresh per call so a mid-run branch switch is reflected. Empty
	// means "use the repo's main working tree" — the sidecar/renderer treat a
	// missing branch exactly like an old client that never sent one.
	Branch string `json:"branch"`
	// Host is the SSH alias for ssh_* tools (empty for repo file tools). The
	// renderer routes ssh_* tools to the sidecar's /__sidecar/ssh/exec endpoint
	// and passes host so the sidecar resolves it via ~/.ssh/config. Empty for
	// repo file tools, which keep using Repo/Branch.
	Host string `json:"host,omitempty"`
	// Target is the UI surface a ui_* tool acts on — always "app" (the chat
	// app's own interface) today. Empty for repo/ssh tools, which route on
	// Repo/Host instead. The field exists from day one so adding a second
	// target later (e.g. a dev-server preview) is a renderer change, not a
	// change to this contract. See agent_ui.go.
	Target string `json:"target,omitempty"`
	// AutoApprove is the conversation's effective auto-approve setting for write
	// tools (write_file/edit_file/move_path/apply_patch/run_command/git_commit/
	// git_push). When true the renderer runs those tools without an approval
	// dialog; delete_path/create_pr/merge_pr always prompt regardless. Carried
	// per-call so a reconnect-replay still has it.
	AutoApprove bool `json:"autoApprove,omitempty"`
	// RunCommandTimeoutMs is the backend's RUN_COMMAND_TIMEOUT in milliseconds,
	// carried per call so the sidecar enforces the backend-authoritative value
	// when running a run_command. 0 means "use the sidecar default (120s)". Only
	// read by run_command's buffered + streaming executors.
	RunCommandTimeoutMs int `json:"runCommandTimeoutMs,omitempty"`
}

// toolStartPayload is the SSE `toolStart` event body: the UI's cue that a tool
// is about to run, so the Warp-style command block can open (spinner) the
// moment execution begins — before the result arrives. Only command-shaped
// tools (run_command/apply_patch/git_commit/git_push/create_pr) render a block;
// the UI ignores toolStart for read-only tools. Mirrors toolExecPayload's
// identity fields so a reconnect can reopen a running block, but carries no
// repo/branch/autoApprove (those are relay concerns on the toolExec event).
type toolStartPayload struct {
	ConvID string `json:"convId"`
	JobID  string `json:"jobId"`
	Step   int    `json:"step"`
	Tool   string `json:"tool"`
	Args   string `json:"args"`
}

// toolExecResponse is the browser's assembled file-tool result, delivered
// through the job's pendingToolExec channel. Observation is the tool output fed
// back to the model; Preview is a short summary for the trace; IsError marks a
// failure. Error, when non-empty, signals the relay couldn't run the tool at
// all (sidecar down, repo not found) — surfaced as an error observation.
type toolExecResponse struct {
	Observation string `json:"observation"`
	Preview     string `json:"preview"`
	IsError     bool   `json:"isError"`
	Error       string `json:"error,omitempty"`
	// ExitCode/Output/Cwd/Branch carry a command's result for the Warp-style
	// command block: exit status, (capped) display-only output, and the cwd/branch
	// it ran in. Populated by the renderer for command-shaped tools; empty for
	// read-only tools. Output is display-only and capped (~4 KB) — it is NOT the
	// model observation (that is Observation).
	ExitCode int    `json:"exitCode,omitempty"`
	Output   string `json:"output,omitempty"`
	Cwd      string `json:"cwd,omitempty"`
	Branch   string `json:"branch,omitempty"`
}

// broadcastControl sends ev to every live subscriber, blocking up to
// controlSendTimeout per subscriber so a critical control event (toolExec,
// modelCall, questions) is never silently dropped when the channel is near-full
// from a burst of chunk events. A stuck client that can't drain within the
// timeout is still skipped (matching the non-blocking semantics of chunk sends)
// — but a healthy client that's briefly behind gets the event delivered instead
// of a hung agent loop.
func (j *job) broadcastControl(ev subEvent, subs []chan subEvent) {
	for _, ch := range subs {
		select {
		case ch <- ev:
		case <-time.After(controlSendTimeout):
		}
	}
}

func newJobID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("%x", time.Now().UnixNano())
	}
	return hex.EncodeToString(b)
}

func newJob(convID, email, model string, webSearch, clarify, agent bool) *job {
	return &job{
		id:        newJobID(),
		convID:    convID,
		email:     email,
		model:     model,
		webSearch: webSearch,
		clarify:   clarify,
		agent:     agent,
		createdAt: time.Now().UnixMilli(),
		status:    "queued",
		subs:      map[chan subEvent]struct{}{},
		finished:  make(chan struct{}),
	}
}

// appendContent adds text to the accumulated content WITHOUT broadcasting a
// chunk event. Used by the browser-relay backend: the browser streams model
// content directly into the answer bubble, so the backend must not re-emit it
// as chunks, but it still needs j.content to hold the assembled reply for
// SQLite persistence and the SSE "reset" replay on reconnect. emitClear still
// rewinds this accumulator between agent thinking rounds, matching directOllama.
func (j *job) appendContent(text string) {
	if text == "" {
		return
	}
	j.mu.Lock()
	j.content.WriteString(text)
	j.mu.Unlock()
}

// emitModelCall stashes the current inference request on the job (so a browser
// that attaches after the cue fired gets it replayed on subscribe) and
// broadcasts a "modelCall" event to every live subscriber, plus this job's
// owner's /api/events hub (contract: every hub event carries convId+jobId, and
// this payload already does). Called by browserRelay.Call at the start of each
// local-model round.
func (j *job) emitModelCall(model string, messages []oaiMessage, tools []oaiTool) {
	payload := modelCallPayload{ConvID: j.convID, JobID: j.id, Model: model, Messages: messages, Tools: tools}
	if j.sampling != nil {
		t := j.sampling.temperature
		p := j.sampling.topP
		payload.Temperature = &t
		payload.TopP = &p
		if j.sampling.seed != 0 {
			s := j.sampling.seed
			payload.Seed = &s
		}
	}
	b, _ := json.Marshal(payload)
	j.mu.Lock()
	j.pendingModelCall = &payload
	subs := make([]chan subEvent, 0, len(j.subs))
	for ch := range j.subs {
		subs = append(subs, ch)
	}
	j.mu.Unlock()
	ev := subEvent{kind: "modelCall", text: string(b)}
	j.broadcastControl(ev, subs)
	j.publishHub(ev)
}

// modelCallSnapshot returns a copy of the pending modelCall for SSE replay on
// (re)connect, or nil if no round is awaiting a browser response.
func (j *job) modelCallSnapshot() *modelCallPayload {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.pendingModelCall == nil {
		return nil
	}
	cp := *j.pendingModelCall
	return &cp
}

// clearPendingModelCall drops the stashed modelCall once the browser's response
// has arrived, so a later reconnect does not replay a round already completed.
func (j *job) clearPendingModelCall() {
	j.mu.Lock()
	j.pendingModelCall = nil
	j.mu.Unlock()
}

// emitToolExec stashes the current local tool call on the job (so a browser
// that attaches after the cue fired gets it replayed on subscribe) and
// broadcasts a "toolExec" event to every live subscriber plus the owner's
// /api/events hub. Called by the agent loop when it hits a local tool (a repo
// file tool or an ssh_* tool), parallel to emitModelCall for local-model
// inference. branch is the conversation's bound branch ("" for the repo's main
// working tree; see toolExecPayload); host is the SSH alias for ssh_* tools
// ("" for repo file tools). runCommandTimeoutMs carries the backend's
// RUN_COMMAND_TIMEOUT so the sidecar enforces it for run_command/ssh_run
// (0 = sidecar default). The ui_* target is stamped here rather than passed in
// (uiTargetFor): it is derived from the tool name, so no caller has to know
// about it.
func (j *job) emitToolExec(step int, tool, args, repo, branch, host string, autoApprove bool, runCommandTimeoutMs int) {
	// Open the command block the moment the tool starts — before the relay cue
	// fires — so streamed output has a block to land in. (Read-only tools get a
	// toolStart too; the UI only opens a block for command-shaped tools.)
	j.emitToolStart(step, tool, args)
	payload := toolExecPayload{ConvID: j.convID, JobID: j.id, Step: step, Tool: tool, Args: args, Repo: repo, Branch: branch, Host: host, Target: uiTargetFor(tool), AutoApprove: autoApprove, RunCommandTimeoutMs: runCommandTimeoutMs}
	b, _ := json.Marshal(payload)
	j.mu.Lock()
	j.pendingToolExecPayload = &payload
	subs := make([]chan subEvent, 0, len(j.subs))
	for ch := range j.subs {
		subs = append(subs, ch)
	}
	j.mu.Unlock()
	ev := subEvent{kind: "toolExec", text: string(b)}
	j.broadcastControl(ev, subs)
	j.publishHub(ev)
}

// toolExecSnapshot returns a copy of the pending toolExec for SSE replay on
// (re)connect, or nil if no file-tool round is awaiting a browser response.
func (j *job) toolExecSnapshot() *toolExecPayload {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.pendingToolExecPayload == nil {
		return nil
	}
	cp := *j.pendingToolExecPayload
	return &cp
}

// clearPendingToolExec drops the stashed toolExec once the browser's response
// has arrived, so a later reconnect does not replay a round already completed.
func (j *job) clearPendingToolExec() {
	j.mu.Lock()
	j.pendingToolExecPayload = nil
	j.mu.Unlock()
}

// emitChunk appends delta to the accumulated content and broadcasts it to every
// subscriber. A slow subscriber's channel is non-blocking: a dropped chunk is
// recovered on the next reconnect via the reset/replay prefix.
func (j *job) emitChunk(delta string) {
	if delta == "" {
		return
	}
	j.mu.Lock()
	j.content.WriteString(delta)
	subs := make([]chan subEvent, 0, len(j.subs))
	for ch := range j.subs {
		subs = append(subs, ch)
	}
	j.mu.Unlock()
	ev := subEvent{kind: "chunk", text: delta}
	for _, ch := range subs {
		select {
		case ch <- ev:
		default:
		}
	}
}

// emitPhase broadcasts a phase hint (e.g. "searching", "answering") so the UI
// can show an appropriate waiting state. The latest phase is also stored so a
// client that connects after the hint fired (a common race: runSearchLoop emits
// "searching" before the SSE stream opens) gets it replayed on subscribe. Also
// published to the owner's /api/events hub so a backgrounded chat's sidebar
// status stays current.
func (j *job) emitPhase(phase string) {
	j.mu.Lock()
	j.phase = phase
	subs := make([]chan subEvent, 0, len(j.subs))
	for ch := range j.subs {
		subs = append(subs, ch)
	}
	j.mu.Unlock()
	ev := subEvent{kind: "phase", text: phase}
	for _, ch := range subs {
		select {
		case ch <- ev:
		default:
		}
	}
	b, _ := json.Marshal(hubPhasePayload{ConvID: j.convID, JobID: j.id, Phase: phase})
	j.publishHub(subEvent{kind: "phase", text: string(b)})
}

// emitSearch records a web-search event (a real query + its sources, or a
// Skipped marker) and broadcasts it to every subscriber so the UI can show
// proof a lookup ran. Also accumulated for persistence and SSE replay.
func (j *job) emitSearch(entry searchEntry) {
	j.mu.Lock()
	j.searches = append(j.searches, entry)
	subs := make([]chan subEvent, 0, len(j.subs))
	for ch := range j.subs {
		subs = append(subs, ch)
	}
	j.mu.Unlock()
	b, _ := json.Marshal(entry)
	ev := subEvent{kind: "search", text: string(b)}
	for _, ch := range subs {
		select {
		case ch <- ev:
		default:
		}
	}
}

// searchSnapshot returns a copy of the accumulated web-search evidence for
// persistence (attached to the saved assistant message) and SSE replay.
func (j *job) searchSnapshot() []searchEntry {
	j.mu.Lock()
	defer j.mu.Unlock()
	if len(j.searches) == 0 {
		return nil
	}
	out := make([]searchEntry, len(j.searches))
	copy(out, j.searches)
	return out
}

// emitQuestions stashes the clarifying question(s) the model produced (so the
// worker can persist them on the assistant message and /events can replay them)
// and broadcasts a "questions" event to every live subscriber so the UI paints
// the clickable option card. Mirrors emitSearch.
func (j *job) emitQuestions(meta clarifyMeta) {
	j.mu.Lock()
	cp := meta
	j.clarifyMeta = &cp
	subs := make([]chan subEvent, 0, len(j.subs))
	for ch := range j.subs {
		subs = append(subs, ch)
	}
	j.mu.Unlock()
	b, _ := json.Marshal(meta)
	ev := subEvent{kind: "questions", text: string(b)}
	j.broadcastControl(ev, subs)
}

// clarifySnapshot returns a copy of the stashed clarifying question(s) for
// persistence and SSE replay, or nil if the model didn't ask.
func (j *job) clarifySnapshot() *clarifyMeta {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.clarifyMeta == nil {
		return nil
	}
	cp := *j.clarifyMeta
	return &cp
}

// emitTool records one agent tool-call step and broadcasts it to every live
// subscriber so the UI can paint the trace. Also accumulated for persistence
// (attached to the saved assistant message) and SSE replay.
func (j *job) emitTool(st agentStep) {
	j.mu.Lock()
	j.steps = append(j.steps, st)
	// A tool's result step closes the running-tool window opened by emitToolStart:
	// drop the stashed toolStart so a later reconnect does not reopen a block for
	// a tool that has already finished.
	j.pendingToolStart = nil
	subs := make([]chan subEvent, 0, len(j.subs))
	for ch := range j.subs {
		subs = append(subs, ch)
	}
	j.mu.Unlock()
	b, _ := json.Marshal(st)
	ev := subEvent{kind: "tool", text: string(b)}
	for _, ch := range subs {
		select {
		case ch <- ev:
		default:
		}
	}
}

// stepSnapshot returns a copy of the accumulated agent tool-call trace for
// persistence (attached to the saved assistant message) and SSE replay.
func (j *job) stepSnapshot() []agentStep {
	j.mu.Lock()
	defer j.mu.Unlock()
	if len(j.steps) == 0 {
		return nil
	}
	out := make([]agentStep, len(j.steps))
	copy(out, j.steps)
	return out
}

// emitToolStart stashes the tool that is about to run on the job (so a browser
// that attaches after the cue fired reopens the running block on reconnect)
// and broadcasts a "toolStart" event to every live subscriber so the UI can
// open the command block the moment execution begins. Per-job only (not the
// /api/events hub): a backgrounded chat's foreground tail replays this on
// subscribe, and toolStart is a transient UI hint, not a relay control event.
func (j *job) emitToolStart(step int, tool, args string) {
	payload := toolStartPayload{ConvID: j.convID, JobID: j.id, Step: step, Tool: tool, Args: args}
	b, _ := json.Marshal(payload)
	j.mu.Lock()
	j.pendingToolStart = &payload
	subs := make([]chan subEvent, 0, len(j.subs))
	for ch := range j.subs {
		subs = append(subs, ch)
	}
	j.mu.Unlock()
	ev := subEvent{kind: "toolStart", text: string(b)}
	j.broadcastControl(ev, subs)
}

// toolStartSnapshot returns a copy of the pending toolStart for SSE replay on
// (re)connect, or nil if no tool is mid-execution.
func (j *job) toolStartSnapshot() *toolStartPayload {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.pendingToolStart == nil {
		return nil
	}
	cp := *j.pendingToolStart
	return &cp
}

// addUsage accumulates token counts reported by the agent loop (one call per
// model round). Thread-safe; the worker reads the totals via usageSnapshot()
// after the run to persist them for observability.
func (j *job) addUsage(prompt, completion int) {
	j.mu.Lock()
	j.promptTokens += prompt
	j.completionTokens += completion
	j.mu.Unlock()
}

// usageSnapshot returns the cumulative (prompt, completion) token counts.
func (j *job) usageSnapshot() (int, int) {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.promptTokens, j.completionTokens
}

// emitThought records one agent reasoning round's text and broadcasts it to every
// live subscriber so the UI can paint it in a smaller, collapsible thinking drawer
// (separate from the answer bubble). Also accumulated for persistence and SSE
// replay. Called by the agent loop at the end of each tool-calling round with
// that round's full streamed text.
func (j *job) emitThought(text string) {
	if strings.TrimSpace(text) == "" {
		return
	}
	j.mu.Lock()
	j.thoughts = append(j.thoughts, text)
	subs := make([]chan subEvent, 0, len(j.subs))
	for ch := range j.subs {
		subs = append(subs, ch)
	}
	j.mu.Unlock()
	d, _ := json.Marshal(text)
	ev := subEvent{kind: "thought", text: string(d)}
	for _, ch := range subs {
		select {
		case ch <- ev:
		default:
		}
	}
}

// thoughtSnapshot returns a copy of the accumulated agent reasoning rounds for
// persistence (attached to the saved assistant message) and SSE replay.
func (j *job) thoughtSnapshot() []string {
	j.mu.Lock()
	defer j.mu.Unlock()
	if len(j.thoughts) == 0 {
		return nil
	}
	out := make([]string, len(j.thoughts))
	copy(out, j.thoughts)
	return out
}

// emitClear clears the answer bubble (broadcasts a "clear" event) and rewinds the
// job's content accumulator so j.content holds only the answer, not the thinking
// that was just moved to the drawer. Called at the end of each agent thinking
// round so the bubble ends up showing only the final synthesized answer.
func (j *job) emitClear() {
	j.mu.Lock()
	j.content.Reset()
	subs := make([]chan subEvent, 0, len(j.subs))
	for ch := range j.subs {
		subs = append(subs, ch)
	}
	j.mu.Unlock()
	ev := subEvent{kind: "clear"}
	for _, ch := range subs {
		select {
		case ch <- ev:
		default:
		}
	}
}

func (j *job) contentString() string {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.content.String()
}

// phaseSnapshot returns the latest phase hint for SSE replay on (re)connect.
func (j *job) phaseSnapshot() string {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.phase
}

// cancel requests a stop. It records the request even before the job starts
// (queued) so the worker drops it without driving Ollama, and calls the job's
// context cancel if it is already running.
func (j *job) cancel() {
	j.mu.Lock()
	j.cancelRequested = true
	c := j.cancelFn
	j.mu.Unlock()
	if c != nil {
		c()
	}
}

// pause requests a pause of an agent-mode run between steps. It records the
// request and cancels the current round's child context so pause takes effect
// within seconds instead of waiting out an inference round; the partial round
// is discarded. runAgentLoop checks pauseRequested at the top of each
// iteration and after each tool result, then returns errAgentPaused carrying
// the transcript and step index. Unlike cancel(), pause does NOT cancel the
// job-level context — the worker finalizes the job as "paused" and writes a
// checkpoint so the run can be resumed.
func (j *job) pause() {
	j.mu.Lock()
	j.pauseRequested = true
	rc := j.roundCancel
	j.mu.Unlock()
	if rc != nil {
		rc()
	}
}

// isPauseRequested is a lock-safe check used by runAgentLoop via a callback.
func (j *job) isPauseRequested() bool {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.pauseRequested
}

// setRoundCancel installs (or clears) the current round's child-context cancel
// func on the job so pause() can abort an in-flight inference round. Used by
// runAgentLoop via a callback; pass nil to clear after the round completes.
func (j *job) setRoundCancel(c context.CancelFunc) {
	j.mu.Lock()
	j.roundCancel = c
	j.mu.Unlock()
}

func (j *job) snapshot() (status, content, errMsg string) {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.status, j.content.String(), j.errMsg
}

// subscribe registers a subscriber and returns its event channel plus the
// content accumulated so far (the replay prefix the SSE handler sends as a
// "reset" event so reconnects don't double-count).
func (j *job) subscribe() (chan subEvent, string) {
	ch := make(chan subEvent, subBufferSize)
	j.mu.Lock()
	j.subs[ch] = struct{}{}
	prefix := j.content.String()
	j.mu.Unlock()
	return ch, prefix
}

func (j *job) unsubscribe(ch chan subEvent) {
	j.mu.Lock()
	delete(j.subs, ch)
	j.mu.Unlock()
}

// notifyDone marks the job done and broadcasts the terminal event. The worker
// calls this AFTER persisting the assistant message, so a subscriber that
// reacts to "done" and reloads the conversation will see the finished reply.
func (j *job) notifyDone() {
	j.mu.Lock()
	if j.status == "done" || j.status == "error" {
		j.mu.Unlock()
		return
	}
	j.status = "done"
	subs := make([]chan subEvent, 0, len(j.subs))
	for ch := range j.subs {
		subs = append(subs, ch)
	}
	close(j.finished)
	j.mu.Unlock()
	for _, ch := range subs {
		select {
		case ch <- subEvent{kind: "done"}:
		default:
		}
	}
	j.publishHubDone("done")
}

// notifyCancelled marks the job cancelled and broadcasts a terminal "done".
// Subscribers treat it like a normal finish (they reload the conversation,
// which now holds the partial assistant reply).
func (j *job) notifyCancelled() {
	j.mu.Lock()
	if j.status == "done" || j.status == "error" || j.status == "cancelled" {
		j.mu.Unlock()
		return
	}
	j.status = "cancelled"
	subs := make([]chan subEvent, 0, len(j.subs))
	for ch := range j.subs {
		subs = append(subs, ch)
	}
	close(j.finished)
	j.mu.Unlock()
	for _, ch := range subs {
		select {
		case ch <- subEvent{kind: "done"}:
		default:
		}
	}
	j.publishHubDone("cancelled")
}

// notifyPaused marks the job paused and broadcasts a terminal "done" carrying
// status:"paused" via the hub (mirrors notifyCancelled). Subscribers treat it
// like a normal finish — they reload the conversation, which holds the partial
// assistant reply with its steps/thoughts, and the UI surfaces a Resume
// affordance from the checkpoint. The per-conversation "done" event carries no
// payload, so the frontend distinguishes paused from done/cancelled via the
// /job status ("paused") rather than the tail event.
func (j *job) notifyPaused() {
	j.mu.Lock()
	if j.status == "done" || j.status == "error" || j.status == "cancelled" || j.status == "paused" {
		j.mu.Unlock()
		return
	}
	j.status = "paused"
	subs := make([]chan subEvent, 0, len(j.subs))
	for ch := range j.subs {
		subs = append(subs, ch)
	}
	close(j.finished)
	j.mu.Unlock()
	for _, ch := range subs {
		select {
		case ch <- subEvent{kind: "done"}:
		default:
		}
	}
	j.publishHubDone("paused")
}

// notifyError marks the job errored and broadcasts the terminal event.
func (j *job) notifyError(msg string) {
	j.mu.Lock()
	if j.status == "done" || j.status == "error" {
		j.mu.Unlock()
		return
	}
	j.status = "error"
	j.errMsg = msg
	subs := make([]chan subEvent, 0, len(j.subs))
	for ch := range j.subs {
		subs = append(subs, ch)
	}
	close(j.finished)
	j.mu.Unlock()
	for _, ch := range subs {
		select {
		case ch <- subEvent{kind: "error", text: msg}:
		default:
		}
	}
	b, _ := json.Marshal(hubErrorPayload{ConvID: j.convID, JobID: j.id, Error: msg})
	j.publishHub(subEvent{kind: "error", text: string(b)})
}

// publishHub forwards an event to this job's owner's /api/events hub, if any
// (nil in tests that build a job directly with newJob). Mirrors the
// non-blocking discipline of the per-job subs broadcast above: a slow /api/
// events subscriber must never block a generation.
func (j *job) publishHub(ev subEvent) {
	if j.hub == nil {
		return
	}
	j.hub.publish(j.email, ev)
}

// publishHubDone marshals and publishes a terminal "done" hub event carrying
// the job's final status ("done" or "cancelled"); notifyError publishes
// "error" directly since it also carries a message.
func (j *job) publishHubDone(status string) {
	b, _ := json.Marshal(hubDonePayload{ConvID: j.convID, JobID: j.id, Status: status})
	j.publishHub(subEvent{kind: "done", text: string(b)})
}

// scheduleGraceCancel starts (or restarts) a countdown after a browser-bound
// job's connection-of-record drops: its per-conversation tail (handleEvents)
// or the owning user's multiplexed stream (handleUserEvents). If neither has
// reattached by the time the timer fires, the job is cancelled — this is what
// lets a chat switch or a page reload survive (either channel reattaching
// within the grace period simply means the check below finds a live
// subscriber and does nothing) while a genuinely closed app still cleans the
// job up. hub may be nil (no /api/events stream configured), in which case
// only the per-conversation tail is checked.
func (j *job) scheduleGraceCancel(grace time.Duration, hub *eventHub) {
	j.mu.Lock()
	if j.graceTimer != nil {
		j.graceTimer.Stop()
	}
	email := j.email
	j.graceTimer = time.AfterFunc(grace, func() {
		j.mu.Lock()
		hasTail := len(j.subs) > 0
		j.mu.Unlock()
		if hasTail || (hub != nil && hub.connected(email)) {
			return
		}
		j.cancel()
	})
	j.mu.Unlock()
}

// --- Event hub: the per-user multiplexed stream (GET /api/events) ---------
//
// eventHub fans modelCall/toolExec/phase/done/joberror events out to every one
// of a user's live /api/events connections. In practice a user has at most one
// such connection open (one browser tab), but the hub supports more so a
// second tab/window isn't starved. This is the second (and last) long-lived
// connection the desktop sidecar's HTTP/1.1 127.0.0.1 origin has to carry
// alongside the one foreground per-conversation tail — bounded regardless of
// how many chats are actually running, which matters because the webview caps
// roughly 6 connections per origin.
type eventHub struct {
	mu   sync.Mutex
	subs map[string]map[chan subEvent]struct{} // email -> subscriber channels
}

func newEventHub() *eventHub {
	return &eventHub{subs: map[string]map[chan subEvent]struct{}{}}
}

// subscribe registers a new /api/events connection for a user.
func (h *eventHub) subscribe(email string) chan subEvent {
	ch := make(chan subEvent, subBufferSize)
	h.mu.Lock()
	if h.subs[email] == nil {
		h.subs[email] = map[chan subEvent]struct{}{}
	}
	h.subs[email][ch] = struct{}{}
	h.mu.Unlock()
	return ch
}

func (h *eventHub) unsubscribe(email string, ch chan subEvent) {
	h.mu.Lock()
	if m := h.subs[email]; m != nil {
		delete(m, ch)
		if len(m) == 0 {
			delete(h.subs, email)
		}
	}
	h.mu.Unlock()
}

// connected reports whether a user currently has a live /api/events
// subscriber. Used by the grace-period cancel: a browser-bound job is not
// cancelled while this stream is still attached, even if its own
// per-conversation tail has dropped (a backgrounded chat).
func (h *eventHub) connected(email string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.subs[email]) > 0
}

// publish sends a non-blocking event to every one of a user's /api/events
// subscribers. A slow subscriber's channel is skipped rather than blocking a
// generation, matching the per-job broadcast discipline.
func (h *eventHub) publish(email string, ev subEvent) {
	h.mu.Lock()
	subs := make([]chan subEvent, 0, len(h.subs[email]))
	for ch := range h.subs[email] {
		subs = append(subs, ch)
	}
	h.mu.Unlock()
	for _, ch := range subs {
		select {
		case ch <- ev:
		default:
		}
	}
}

// hubPhasePayload/hubDonePayload/hubErrorPayload are the JSON bodies for the
// phase/done/joberror events on GET /api/events. modelCall and toolExec reuse
// their existing per-conversation payload structs (already carrying convId +
// jobId), but phase/done/error have no JSON payload on the per-conversation
// stream (bare text), so the hub needs its own small envelopes to satisfy
// contract 1: every event's payload includes convId and jobId.
type hubPhasePayload struct {
	ConvID string `json:"convId"`
	JobID  string `json:"jobId"`
	Phase  string `json:"phase"`
}

type hubDonePayload struct {
	ConvID string `json:"convId"`
	JobID  string `json:"jobId"`
	Status string `json:"status"` // done, cancelled
}

type hubErrorPayload struct {
	ConvID string `json:"convId"`
	JobID  string `json:"jobId"`
	Error  string `json:"error"`
}

// --- Job manager ---

type jobManager struct {
	mu     sync.Mutex
	active map[string]*job // keyed by conversation ID
	queue  chan *job
	store  *store
	srv    *server
	// hostSem serializes server-side inference per host: the NAS/Mac run Ollama
	// with OLLAMA_NUM_PARALLEL=1, so two workers dialing the same host at once
	// would just queue inside Ollama anyway. Keyed by host.name and seeded once
	// from the host registry at construction, so it's safe to read without a
	// lock afterward. Browser-relay jobs (j.local) never touch this — they run
	// on the visitor's own machine, which is what actually parallelizes.
	hostSem map[string]chan struct{}
}

// newJobManager starts a pool of workers draining one shared queue.
// MAX_CONCURRENT_JOBS (via srv.cfg.maxConcurrentJobs) sizes the pool; a
// browser-relay job blocks its worker while it awaits the user's browser
// (POST /model-response), so with a single worker one local-model chat used to
// stall every other chat. Multiple workers let those coexist; server-side
// inference itself stays serialized per host via hostSem.
func newJobManager(store *store, srv *server) *jobManager {
	hostSem := map[string]chan struct{}{}
	if srv != nil && srv.hosts != nil {
		for _, h := range srv.hosts.all() {
			hostSem[h.name] = make(chan struct{}, 1)
		}
	}
	jm := &jobManager{
		active:  map[string]*job{},
		queue:   make(chan *job, 64),
		store:   store,
		srv:     srv,
		hostSem: hostSem,
	}
	workers := 1
	if srv != nil && srv.cfg.maxConcurrentJobs > 0 {
		workers = srv.cfg.maxConcurrentJobs
	}
	for i := 0; i < workers; i++ {
		go jm.worker()
	}
	return jm
}

// acquireHost blocks until the named host's single server-side inference slot
// is free (or ctx is done), matching OLLAMA_NUM_PARALLEL=1 on the NAS/Mac.
// Returns a release func to defer. An unrecognized host name (shouldn't happen
// since hostSem is seeded from the same registry callers resolve hosts
// through) is treated as unguarded.
func (jm *jobManager) acquireHost(ctx context.Context, name string) (func(), error) {
	sem, ok := jm.hostSem[name]
	if !ok {
		return func() {}, nil
	}
	select {
	case sem <- struct{}{}:
		return func() { <-sem }, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// scheduleGraceForUser starts a grace-period check (see job.scheduleGraceCancel)
// for every one of a user's active jobs that needs the browser. Called when
// that user's /api/events hub connection drops, mirroring the per-job grace
// scheduled in handleEvents when a foreground per-conversation tail drops. A
// job whose per-conversation tail is still open is scheduled too, but its
// grace check will simply find that tail live and do nothing.
func (jm *jobManager) scheduleGraceForUser(email string, grace time.Duration, hub *eventHub) {
	jm.mu.Lock()
	jobs := make([]*job, 0, len(jm.active))
	for _, j := range jm.active {
		if j.email == email && j.needsBrowser {
			jobs = append(jobs, j)
		}
	}
	jm.mu.Unlock()
	for _, j := range jobs {
		j.scheduleGraceCancel(grace, hub)
	}
}

func (jm *jobManager) enqueue(j *job) error {
	jm.mu.Lock()
	if _, ok := jm.active[j.convID]; ok {
		jm.mu.Unlock()
		return errJobActive
	}
	jm.active[j.convID] = j
	jm.mu.Unlock()
	if err := jm.store.createJob(j); err != nil {
		jm.mu.Lock()
		delete(jm.active, j.convID)
		jm.mu.Unlock()
		return err
	}
	jm.queue <- j
	return nil
}

func (jm *jobManager) get(convID string) *job {
	jm.mu.Lock()
	defer jm.mu.Unlock()
	return jm.active[convID]
}

// cancel requests a stop for the conversation's active job. Returns false if
// there is no active job for this conversation/user (so the handler can 404).
// A queued job is dropped before it starts; a running job has its Ollama
// request aborted via the job's context. Either way the worker finalizes the
// job as cancelled (partial content persisted).
func (jm *jobManager) cancel(convID, email string) bool {
	jm.mu.Lock()
	j, ok := jm.active[convID]
	jm.mu.Unlock()
	if !ok || j.email != email {
		return false
	}
	j.cancel()
	return true
}

// pause requests a pause of the conversation's active agent job between steps.
// Returns false if there is no active job for this conversation/user. Only an
// agent-mode run is pausable (plain chat/search/clarify have nothing to
// resume); a non-agent job is left alone and the caller surfaces a 409.
func (jm *jobManager) pause(convID, email string) bool {
	jm.mu.Lock()
	j, ok := jm.active[convID]
	jm.mu.Unlock()
	if !ok || j.email != email || !j.agent {
		return false
	}
	j.pause()
	return true
}

func (jm *jobManager) activeByUser(email string) map[string]string {
	jm.mu.Lock()
	defer jm.mu.Unlock()
	out := map[string]string{}
	for cid, j := range jm.active {
		if j.email == email {
			st, _, _ := j.snapshot()
			out[cid] = st
		}
	}
	return out
}

// worker is one of MAX_CONCURRENT_JOBS generation slots. It drives Ollama on
// context.Background() (plus a timeout) so an SSE disconnect never outright
// kills a job — the grace-period cancel (job.scheduleGraceCancel) governs
// browser-bound jobs instead. A browser-relay job blocks its worker while it
// awaits the user's browser (POST /model-response); with only one worker, one
// local-model chat used to stall every other chat in the queue, which is why
// there are now several of these running concurrently. Server-side inference
// itself stays serialized per host via jm.acquireHost, matching
// OLLAMA_NUM_PARALLEL=1 on the NAS/Mac. After the assistant message is
// persisted, it notifies subscribers.
func (jm *jobManager) worker() {
	for j := range jm.queue {
		j.mu.Lock()
		if j.cancelRequested {
			// Stopped while still queued: never start Ollama.
			j.mu.Unlock()
			_ = jm.store.finalizeJob(j.id, "cancelled", "", time.Now().UnixMilli())
			j.notifyCancelled()
			jm.mu.Lock()
			delete(jm.active, j.convID)
			jm.mu.Unlock()
			continue
		}
		j.status = "generating"
		j.mu.Unlock()
		_ = jm.store.setJobGenerating(j.id)

		err := jm.srv.runGeneration(j)
		content := j.contentString()
		var smeta *searchMeta
		if searches := j.searchSnapshot(); len(searches) > 0 {
			smeta = &searchMeta{Searches: searches}
		}
		// A clarifying turn (the model called ask_user) stashes its structured
		// question card on the job. Persist the question text as the assistant
		// content (so the model has context for the user's follow-up answer) and
		// attach the card for the UI. Preamble the model streamed before calling
		// ask_user is dropped in favor of the explicit question text. This covers
		// both the one-shot clarify loop and the agent loop (whose ask_user tool
		// also calls emitQuestions when it goes terminal).
		var cmeta *clarifyMeta
		if cm := j.clarifySnapshot(); cm != nil {
			cmeta = cm
			content = clarifyAsContent(cm)
		}
		// Agent-mode turns carry their tool-call trace on the message so a reload
		// re-paints the steps drawer, and the per-round reasoning in a smaller
		// collapsible thinking drawer.
		steps := j.stepSnapshot()
		thoughts := j.thoughtSnapshot()
		// Observability: persist the per-step trace (agent_steps) and the cumulative
		// token totals (jobs.prompt_tokens / completion_tokens) for analytics.
		// Best-effort: a failure here never undoes a successful generation.
		if j.agent {
			p, c := j.usageSnapshot()
			_ = jm.store.setJobTokens(j.id, p, c)
			_ = jm.store.persistAgentSteps(j.id, steps)
		}

		j.mu.Lock()
		cancelled := j.cancelRequested // set by cancel() before it fires the context
		j.mu.Unlock()
		// A pause surfaces as errAgentPaused carrying the transcript + step; a
		// resumed run that pauses again upserts a fresh checkpoint over the old.
		var paused *pausedError
		isPaused := errors.As(err, &paused)

		switch {
		case isPaused:
			// Paused by the user between steps: persist the partial reply (so the
			// trace/steps survive in the conversation), write a checkpoint so the
			// run can be resumed, and finalize as "paused" (not error/cancelled).
			// reconcileJobs only touches queued/generating, so a paused job is
			// still resumable after a backend restart.
			ts := time.Now().UnixMilli()
			if strings.TrimSpace(content) != "" {
				_ = jm.store.setJobContent(j.id, content)
				_ = jm.store.appendAssistantMessage(j.email, j.convID, Message{Role: "assistant", Content: content, Ts: ts, Search: smeta, Clarify: cmeta, Steps: steps, Thoughts: thoughts})
			}
			if paused != nil {
				j.mu.Lock()
				j.pausedStep = paused.step
				j.mu.Unlock()
				_ = jm.store.saveCheckpoint(agentCheckpoint{
					JobID: j.id, ConvID: j.convID, Email: j.email, Step: paused.step,
					Transcript: paused.transcript, Model: j.model, Local: j.local,
					SupportsTools: j.supportsTools, Tier: j.tier, CreatedAt: ts,
				})
			}
			_ = jm.store.finalizeJob(j.id, "paused", "", ts)
			j.notifyPaused()
		case cancelled:
			// Stopped by the user: persist the partial reply (if any) and report
			// a clean "done" to subscribers rather than an error. Keep any live
			// checkpoint so a paused-then-cancelled run can still be resumed.
			ts := time.Now().UnixMilli()
			if strings.TrimSpace(content) != "" {
				_ = jm.store.setJobContent(j.id, content)
				_ = jm.store.appendAssistantMessage(j.email, j.convID, Message{Role: "assistant", Content: content, Ts: ts, Search: smeta, Clarify: cmeta, Steps: steps, Thoughts: thoughts})
			}
			_ = jm.store.finalizeJob(j.id, "cancelled", "", ts)
			j.notifyCancelled()
		case err != nil:
			_ = jm.store.finalizeJob(j.id, "error", err.Error(), time.Now().UnixMilli())
			j.notifyError(err.Error())
		default:
			_ = jm.store.setJobContent(j.id, content)
			ts := time.Now().UnixMilli()
			_ = jm.store.appendAssistantMessage(j.email, j.convID, Message{Role: "assistant", Content: content, Ts: ts, Search: smeta, Clarify: cmeta, Steps: steps, Thoughts: thoughts})
			_ = jm.store.finalizeJob(j.id, "done", "", ts)
			j.notifyDone()
			// A clean finish completes the task: drop any live checkpoint so a
			// resumed conversation doesn't keep a lingering "paused" state.
			if j.agent {
				_ = jm.store.deleteCheckpoint(j.email, j.convID)
			}
		}

		jm.mu.Lock()
		delete(jm.active, j.convID)
		jm.mu.Unlock()
	}
}

// --- Generation (drives Ollama detached from any HTTP request) ---

// messageContent builds the OpenAI `content` field for a stored Message.
// Text-only messages stay a plain JSON string (what non-vision models expect);
// a message carrying Images becomes an array of typed parts —
// [{type:"text",text:…},{type:"image_url",image_url:{url:…}}] — so a vision
// model such as gemma3:4b actually receives the image. Images are stored as
// data URLs and passed through verbatim.
func messageContent(m Message) json.RawMessage {
	if len(m.Images) == 0 {
		return jsonString(m.Content)
	}
	type imageURL struct {
		URL string `json:"url"`
	}
	type part struct {
		Type     string    `json:"type"`
		Text     string    `json:"text,omitempty"`
		ImageURL *imageURL `json:"image_url,omitempty"`
	}
	parts := make([]part, 0, 1+len(m.Images))
	if m.Content != "" {
		parts = append(parts, part{Type: "text", Text: m.Content})
	}
	for _, img := range m.Images {
		parts = append(parts, part{Type: "image_url", ImageURL: &imageURL{URL: img}})
	}
	b, _ := json.Marshal(parts)
	return json.RawMessage(b)
}

// runGeneration loads the conversation, builds the message list, and drives
// model inference on a background context. Content deltas flow through the
// job's broadcast. The modelBackend is chosen once here: a browser relay for a
// local-model job (the visitor's Ollama is on localhost:11434, which the NAS
// cannot dial, so the browser runs inference and POSTs the result back), or a
// direct dial to the server-side host that owns the model otherwise (a NAS
// model runs on the NAS, a Mac model on the Mac). Returns nil on a clean
// finish, an error otherwise.
func (s *server) runGeneration(j *job) error {
	// Agent-mode runs need a longer leash than plain chat: apply_patch,
	// run_command, git_commit, git_push, and create_pr all block on a user
	// approval dialog, which genTimeout's 5m was never meant to cover.
	timeout := genTimeout
	if j.agent {
		timeout = s.cfg.agentJobTimeout
		if timeout <= 0 {
			timeout = defaultAgentJobTimeout
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	j.mu.Lock()
	j.cancelFn = cancel // let handleCancel / handleEvents abort the in-flight request
	j.mu.Unlock()

	// Pick the inference backend. A local-model job relays through the browser;
	// otherwise resolve the server-side host that owns the model and dial it
	// directly. If no online host has a server model (e.g. it lives on the Mac
	// and the Mac is asleep/offline), fail fast with a clear message instead of
	// dialing the NAS and getting a bare not-found.
	//
	// Sampling params (temperature/top_p/seed) are attached to the backend for
	// agent/search/clarify runs only — plain chat stays on Ollama's Modelfile
	// defaults. The server backend reads them in Call; the relay reads them off
	// the job in emitModelCall (set below).
	var sampling *agentSampling
	if j.agent || j.clarify || j.webSearch {
		sampling = &agentSampling{temperature: s.cfg.agentTemperature, topP: s.cfg.agentTopP, seed: s.cfg.agentSeed}
	}
	var mb modelBackend
	if j.local {
		mb = &browserRelay{j: j}
		j.sampling = sampling
	} else {
		h := s.hosts.onlineHostForModel(j.model)
		if h == nil {
			return fmt.Errorf("model %q is unavailable — its backend may be offline. Try a smaller model or reconnect the host.", j.model)
		}
		// Serialize server-side inference per host: the NAS/Mac run Ollama with
		// OLLAMA_NUM_PARALLEL=1, so two workers dialing the same host at once
		// would just queue inside Ollama anyway. A browser-relay job never reaches
		// this branch — it executes on the visitor's own machine — so only
		// server-model jobs contend for this slot, which is what lets any number
		// of concurrent browser-relay chats coexist with them.
		release, err := s.jobs.acquireHost(ctx, h.name)
		if err != nil {
			return err
		}
		defer release()
		mb = &directOllama{chatURL: h.chatURL(), emit: j.emitChunk, sampling: sampling}
	}

	conv, err := s.store.getConversation(j.email, j.convID)
	if err != nil {
		return fmt.Errorf("load conversation: %w", err)
	}
	if conv == nil {
		return errors.New("conversation not found")
	}

	msgs := make([]oaiMessage, len(conv.Messages))
	hasImages := false
	for i, m := range conv.Messages {
		msgs[i] = oaiMessage{Role: m.Role, Content: messageContent(m)}
		if len(m.Images) > 0 {
			hasImages = true
		}
	}

	// Tool-capability guard. web_search/ask_user are OpenAI-style tools: the
	// model must emit structured tool_calls deltas to actually trigger a lookup.
	// A non-tool model given the tool schema can't emit tool_calls, so it
	// narrates the call in prose and fabricates a "result" (the reported bug:
	// a hallucinated answer presented as if a search ran). Skip the tool loop
	// entirely and fall through to a plain streamed answer with an honest
	// marker, so the user gets a real answer instead of a hallucination.
	if j.agent || j.clarify || j.webSearch {
		if !s.supportsTools(j.model, j.local, j.supportsTools) {
			reason := fmt.Sprintf("%s has no tool support — use a tool-capable model (e.g. qwen3:1.7b, llama3.1:8b) or turn off Web search/Agent/Clarify.", j.model)
			if j.webSearch {
				j.emitSearch(searchEntry{Skipped: true, Reason: reason})
			} else if j.agent {
				j.emitTool(agentStep{Step: 1, Tool: "(direct)", Preview: reason, IsError: true})
			}
			j.emitPhase(phaseForImages(hasImages))
			return s.runStreamPass(ctx, mb, j.model, msgs, j.emitChunk)
		}
	}

	if j.agent {
		j.tier = s.resolveAgentTier(j.model, j.local, j.feTier)
		allow, sys := s.agentConfig(j)
		repoID, _ := s.store.getConvRepoID(j.email, j.convID)
		sshHosts, _ := s.store.listSSHHosts(j.email)
		// SSH tools are opt-in (not in defaultAgentTools). When the user has no
		// configured hosts, drop any ssh_* tools from the allowlist so a run never
		// offers tools whose host enum would be empty (toolRegistry also won't
		// register them — this guards a host deleted after the allowlist was saved).
		if len(sshHosts) == 0 {
			allow = filterSSHTools(allow)
		}
		sshEnabled := len(sshHosts) > 0 && containsAnySSHTool(allow)
		// UI tools (ui_snapshot/ui_read/ui_click/ui_set_value) are executed by the
		// page itself, so they need the toolExec relay but no repo and no host —
		// this is what makes them work in a plain, non-repo chat. The prompt block
		// goes on here too: without it the model disclaims ("I'm unable to
		// interact with the user interface") instead of taking a snapshot.
		uiEnabled := containsAnyUITool(allow)
		if uiEnabled {
			sys = injectUIContext(sys)
		}

		var repo *Repo
		if repoID != "" {
			if r, err := s.store.getRepo(j.email, repoID); err == nil && r != nil {
				repo = r
				if r.UseGit {
					allow = append(allow, localRepoTools()...)
					sys = injectRepoContext(sys, repo, conv.RepoBranch)
				} else {
					// Non-git workspace: file tools only (no git tools/routes/controls).
					allow = append(allow, localFileTools()...)
					sys = injectWorkspaceContext(sys, repo)
				}
			}
		}
		// No workspace bound, but the relay exists (a UI-only or SSH-only run):
		// drop the repo file/git/todo tools. runAgentLoop's own "local tool with
		// no relay" guard used to cover this, but the relay is no longer
		// repo-implied — offering them now would hand the model tools whose cue
		// nothing can serve.
		if repo == nil {
			allow = filterRepoTools(allow)
		}
		// Plan mode: when the conversation is in plan mode, inject the plan
		// context. If the plan hasn't been approved yet, gate write tools out so
		// the agent researches with read-only tools and emits a plan for the
		// user to approve; after approval, write tools are unlocked and the plan
		// context persists so the implementation run stays grounded in it.
		if conv.PlanMode {
			sys = injectPlanContext(sys, conv.Plan, conv.PlanApproved)
			if !conv.PlanApproved {
				allow = filterPlanWriteTools(allow)
			}
		}

		var toolExecRelay func(context.Context, int, string, string) toolOutcome
		if repo != nil || sshEnabled || uiEnabled {
			// Resolve the conversation's effective auto-approve once for this run;
			// the renderer uses it to skip the approval dialog for write tools
			// (delete_path/create_pr/merge_pr/ssh_run always prompt regardless).
			autoApprove := s.store.convAutoApprove(j.email, j.convID)
			// Carry the backend's RUN_COMMAND_TIMEOUT (ms) on each toolExec so the
			// sidecar enforces it for run_command/ssh_run; 0 lets the sidecar use
			// its own default when the backend didn't configure one.
			runCmdTimeoutMs := 0
			if s.cfg.runCommandTimeout > 0 {
				runCmdTimeoutMs = int(s.cfg.runCommandTimeout / time.Millisecond)
			}
			toolExecRelay = func(ctx context.Context, step int, tool, args string) toolOutcome {
				respCh := make(chan toolExecResponse, 1)
				j.mu.Lock()
				j.pendingToolExec = respCh
				j.mu.Unlock()
				defer func() {
					j.mu.Lock()
					if j.pendingToolExec == respCh {
						j.pendingToolExec = nil
					}
					j.mu.Unlock()
				}()
				// Build the cue payload. SSH tools carry the host alias (parsed from
				// args and validated against the user's allowlist) and no repo/branch;
				// repo tools carry the repo fullname + branch. The renderer routes on
				// tool name to the sidecar endpoint (ssh_* → /__sidecar/ssh/exec).
				var repoName, branch, host string
				if isSSHTool(tool) {
					host = parseSSHHost(args)
					if host == "" {
						return toolOutcome{observation: "No host provided for " + tool + ". Set the host parameter to one of your configured SSH aliases.", preview: "no host", isError: true}
					}
					if !sshHostAllowed(sshHosts, host) {
						return toolOutcome{observation: "Unknown SSH host: " + host + ". Use one of your configured hosts: " + sshHostList(sshHosts) + ".", preview: "unknown host", isError: true}
					}
				} else if isUITool(tool) {
					// UI tools carry neither repo nor host: emitToolExec stamps the
					// target and the page executes against its own DOM. Leaving repo
					// unset keeps a repo-bound chat's ui_* call from looking like a
					// sidecar file-tool call to the renderer.
				} else if repo != nil {
					repoName = repo.FullName
					branch = conv.RepoBranch
				}
				j.emitToolExec(step, tool, args, repoName, branch, host, autoApprove, runCmdTimeoutMs)
				// apply_patch/run_command/git_*/ssh_run block on a user approval
				// dialog, which can take far longer than a plain tool call — give it
				// its own budget (TOOL_EXEC_TIMEOUT) rather than the whole-job timeout.
				toolTimeout := s.cfg.toolExecTimeout
				if toolTimeout <= 0 {
					toolTimeout = defaultToolExecTimeout
				}
				timer := time.NewTimer(toolTimeout)
				defer timer.Stop()
				select {
				case resp, ok := <-respCh:
					if !ok {
						return toolOutcome{observation: "tool execution cancelled", preview: "cancelled", isError: true}
					}
					if resp.Error != "" {
						j.clearPendingToolExec()
						return toolOutcome{observation: resp.Error, preview: trimPreview(resp.Error), isError: true}
					}
					j.clearPendingToolExec()
					return toolOutcome{
						observation: capObservation(resp.Observation, agentObsMaxChars),
						preview:     resp.Preview,
						isError:     resp.IsError,
						exitCode:    resp.ExitCode,
						output:      capObservation(resp.Output, agentOutputMaxChars),
						cwd:         resp.Cwd,
						branch:      resp.Branch,
					}
				case <-timer.C:
					return toolOutcome{observation: "tool execution timed out", preview: "timeout", isError: true}
				case <-ctx.Done():
					return toolOutcome{observation: "tool execution cancelled", preview: "cancelled", isError: true}
				}
			}
		}
		// Resume: rehydrate the transcript from a live checkpoint and continue on
		// the remaining budget. Drop the checkpoint's stale system message
		// (messages[0]); runAgentLoop prepends a freshly built one (current
		// date/repo/branch) so the resumed run does not inherit a stale context.
		// Append the user's resume note (if any) as a user turn. A fresh run
		// (no checkpoint, or a resume whose checkpoint was deleted) uses the
		// conversation messages built above, unchanged.
		resumeStep := 0
		if j.resuming {
			if cp, cpErr := s.store.loadCheckpoint(j.email, j.convID); cpErr == nil && cp != nil {
				resumeStep = cp.Step
				cpMsgs := cp.Transcript
				if len(cpMsgs) > 0 && cpMsgs[0].Role == "system" {
					cpMsgs = cpMsgs[1:]
				}
				if note := strings.TrimSpace(j.resumeNote); note != "" {
					cpMsgs = append(cpMsgs, oaiMessage{Role: "user", Content: jsonString(note)})
				}
				msgs = cpMsgs
			}
		}
		// Prose clarifying-question bridge budget: a model that can't emit
		// structured tool_calls may ask the user in prose instead of calling
		// ask_user. runAgentLoop bridges such prose to a clarify card, but only
		// while the recent back-to-back clarify count is under MAX_CLARIFY_ROUNDS
		// (mirroring the clarify path's own cap) so the agent cannot stall on
		// endless questions across a conversation.
		clarifyBudget := s.cfg.maxClarifyRounds - countRecentClarify(conv.Messages)
		if clarifyBudget < 0 {
			clarifyBudget = 0
		}
		return s.runAgentLoop(ctx, mb, j.model, j.email, msgs, allow, sys, j.emitChunk, j.emitPhase, j.emitTool, j.emitQuestions, j.emitThought, j.emitClear, j.addUsage, repoID, toolExecRelay, j.isPauseRequested, j.setRoundCancel, resumeStep, clarifyBudget, j.tier)
	}
	if j.clarify {
		// Cap back-to-back clarifying questions at MAX_CLARIFY_ROUNDS: once the
		// model has asked that many in the current clarify session, drop the
		// ask_user tool and answer directly (a plain streamed pass). Otherwise
		// run the one-shot agent loop, which is terminal when the model calls
		// ask_user (it stashes the card on the job and returns nil).
		if countRecentClarify(conv.Messages) >= s.cfg.maxClarifyRounds {
			j.emitPhase(phaseForImages(hasImages))
			return s.runStreamPass(ctx, mb, j.model, msgs, j.emitChunk)
		}
		return s.runClarifyLoop(ctx, mb, j.model, msgs, j.emitChunk, j.emitPhase, j.emitQuestions)
	}
	if j.webSearch {
		if s.cfg.searxngURL == "" {
			// Toggle was on but no SearXNG backend configured: surface it instead
			// of silently answering as if search were off.
			j.emitSearch(searchEntry{Skipped: true, Reason: "web search not configured"})
			j.emitPhase(phaseForImages(hasImages))
			return s.runStreamPass(ctx, mb, j.model, msgs, j.emitChunk)
		}
		return s.runSearchLoop(ctx, mb, j.model, msgs, j.emitChunk, j.emitPhase, j.emitSearch)
	}
	// Plain turn. For tool-capable text models, offer the ask_user tool so a
	// clarifying question renders as an interactive card instead of prose — the
	// default chat path used to stream with no tools, so a model that wanted to
	// clarify could only emit text. If the model calls ask_user, the pass stashes
	// the card (emitQuestions) and returns; if it answers directly we fall through
	// to the prose-question detector as a fallback for small/non-tool models that
	// write the question as text. Vision turns and non-tool models skip the pass
	// (no tool-schema overhead on the slow vision path; non-tool models can't
	// emit tool_calls). Gated by ASK_USER_IN_PLAIN_CHAT / CLARIFY_PROSE_DETECT.
	if s.cfg.askUserInPlainChat && !hasImages && s.supportsTools(j.model, j.local, j.supportsTools) {
		asked, err := s.runAskUserPass(ctx, mb, j.model, msgs, j.emitChunk, j.emitPhase, j.emitQuestions, phaseForImages(hasImages), askUserLightNudgeText()+"\n\n"+plainChatNudge())
		if err != nil {
			return err
		}
		if asked {
			return nil
		}
		if s.cfg.clarifyProseDetect {
			if meta := detectClarifyFromContent(j.contentString()); meta != nil {
				j.emitQuestions(*meta)
				return nil
			}
		}
		return nil
	}
	// Non-tool / vision / disabled: a plain streamed pass. Emit an honest phase
	// so a connect-time "queued" hint clears as soon as the worker starts the
	// job. A vision turn reports "vision" — the SigLIP encoder runs before the
	// first token, which takes tens of seconds on the N100, so without this the
	// stale "queued" label (set at enqueue) would mislead the user into thinking
	// another reply is blocking. A text turn reports "answering".
	j.emitPhase(phaseForImages(hasImages))
	plainMsgs := append([]oaiMessage{{Role: "system", Content: jsonString(plainChatNudge())}}, msgs...)
	return s.runStreamPass(ctx, mb, j.model, plainMsgs, j.emitChunk)
}

// phaseForImages returns the generation phase hint for a non-search turn:
// "vision" when the turn carries images (the vision encoder runs before the
// first token), otherwise "answering".
func phaseForImages(hasImages bool) string {
	if hasImages {
		return "vision"
	}
	return "answering"
}

// runStreamPass drives a plain (no-tools) completion through the model backend,
// emitting content deltas. For a server backend the content streams live to
// the job as it arrives (and an empty reply surfaces as an error, matching the
// prior streamFromOllama behavior); for a browser relay the browser streams the
// output directly and Call returns the assembled text, so a genuinely empty
// local reply emits a synthetic "(no response)" instead of failing the job.
// Returns nil on a clean finish, an error otherwise.
func (s *server) runStreamPass(ctx context.Context, mb modelBackend, model string, msgs []oaiMessage, emit func(string)) error {
	msg, _, err := mb.Call(ctx, model, msgs, nil)
	if err != nil {
		return err
	}
	if contentText(msg.Content) == "" {
		emit("(no response)")
	}
	return nil
}

// streamFromOllama POSTs a streaming chat completion and pipes parsed content
// deltas to emit. Returns nil on [DONE] or EOF-with-content, an error
// otherwise. Host is forced to localhost:11434 and Origin/Referer stripped,
// mirroring the Caddy reverse proxy (Ollama 403s non-localhost Hosts and any
// request carrying an Origin).
func (s *server) streamFromOllama(ctx context.Context, target string, req *chatRequest, emit func(string)) error {
	req.Stream = true
	payload, err := json.Marshal(req)
	if err != nil {
		return err
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Host = "localhost:11434"
	httpReq.Header.Del("Origin")
	httpReq.Header.Del("Referer")
	resp, err := http.DefaultClient.Do(httpReq)
	if err != nil {
		return fmt.Errorf("model request failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("model error: %s", resp.Status)
	}
	br := bufio.NewReader(resp.Body)
	got := false
	for {
		line, err := br.ReadBytes('\n')
		if len(line) > 0 {
			t := strings.TrimSpace(string(line))
			if strings.HasPrefix(t, "data: ") {
				data := t[6:]
				if data == "[DONE]" {
					if !got {
						return errors.New("empty response from model")
					}
					return nil
				}
				var o struct {
					Choices []struct {
						Delta struct {
							Content string `json:"content"`
						} `json:"delta"`
					} `json:"choices"`
				}
				if json.Unmarshal([]byte(data), &o) == nil && len(o.Choices) > 0 {
					if c := o.Choices[0].Delta.Content; c != "" {
						got = true
						emit(c)
					}
				}
			}
		}
		if err != nil {
			if got {
				return nil // connection ended after content; treat as success
			}
			if err == io.EOF {
				return errors.New("empty response from model")
			}
			return fmt.Errorf("connection lost: %w", err)
		}
	}
}

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
	subBufferSize  = 512 // ~50s of tokens at 10 tok/s on the N100; live clients read far faster
	keepaliveEvery = 5 * time.Second
)

// errJobActive means a generation job is already running for a conversation.
var errJobActive = errors.New("a generation is already running for this conversation")

// subEvent is a single event pushed to an SSE subscriber.
type subEvent struct {
	// kind is one of: chunk, phase, search, questions, tool, thought, clear,
	// modelCall, done, error. "modelCall" is the browser-relay cue: it carries a
	// modelCallPayload telling the browser to run inference on its own Ollama and
	// POST the result back to /model-response.
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
	createdAt int64

	promptTokens     int // agent-mode: cumulative prompt tokens (observability)
	completionTokens int // agent-mode: cumulative completion tokens (observability)

	// local marks a browser-relay (local-model) job: inference runs on the
	// visitor's Ollama via the browser, so the backend emits modelCall events and
	// awaits POST /model-response instead of dialing a server host. A local job
	// is also connection-bound: when the SSE /events tail disconnects (tab closed
	// or navigated), handleEvents cancels it so the pending relay wait aborts and
	// the worker finalizes the partial reply as cancelled. Server-model jobs stay
	// detached and survive a disconnect.
	local bool

	mu              sync.Mutex
	status          string // queued, generating, done, error, cancelled
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

	// pendingRelay is set by browserRelay.Call while it awaits the browser's POST
	// /model-response for the current round. handleModelResponse claims it under
	// mu (one deliverer wins) and sends the response, then Call clears it. Nil
	// when no relay round is in flight. Local-model jobs only.
	pendingRelay chan relayResponse
	// pendingModelCall is the last modelCall awaiting a browser response. It is
	// replayed as an SSE event on (re)connect so a browser that attaches after
	// the cue fired still runs the round. Cleared once the response arrives.
	pendingModelCall *modelCallPayload
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
	JobID    string       `json:"jobId"`
	Model    string       `json:"model"`
	Messages []oaiMessage `json:"messages"`
	Tools    []oaiTool    `json:"tools,omitempty"`
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
// broadcasts a "modelCall" event to every live subscriber. Called by
// browserRelay.Call at the start of each local-model round.
func (j *job) emitModelCall(model string, messages []oaiMessage, tools []oaiTool) {
	payload := modelCallPayload{JobID: j.id, Model: model, Messages: messages, Tools: tools}
	b, _ := json.Marshal(payload)
	j.mu.Lock()
	j.pendingModelCall = &payload
	subs := make([]chan subEvent, 0, len(j.subs))
	for ch := range j.subs {
		subs = append(subs, ch)
	}
	j.mu.Unlock()
	ev := subEvent{kind: "modelCall", text: string(b)}
	for _, ch := range subs {
		select {
		case ch <- ev:
		default:
		}
	}
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
// "searching" before the SSE stream opens) gets it replayed on subscribe.
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
	for _, ch := range subs {
		select {
		case ch <- ev:
		default:
		}
	}
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
}

// --- Job manager ---

type jobManager struct {
	mu     sync.Mutex
	active map[string]*job // keyed by conversation ID
	queue  chan *job
	store  *store
	srv    *server
}

func newJobManager(store *store, srv *server) *jobManager {
	jm := &jobManager{
		active: map[string]*job{},
		queue:  make(chan *job, 64),
		store:  store,
		srv:    srv,
	}
	go jm.worker()
	return jm
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

// worker is the single generation slot, matching OLLAMA_NUM_PARALLEL=1: jobs
// run one at a time; others wait queued. It drives Ollama on
// context.Background() (plus a timeout) so a browser disconnect never cancels
// generation. After the assistant message is persisted, it notifies
// subscribers.
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

		switch {
		case cancelled:
			// Stopped by the user: persist the partial reply (if any) and report
			// a clean "done" to subscribers rather than an error.
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
	ctx, cancel := context.WithTimeout(context.Background(), genTimeout)
	defer cancel()
	j.mu.Lock()
	j.cancelFn = cancel // let handleCancel / handleEvents abort the in-flight request
	j.mu.Unlock()

	// Pick the inference backend. A local-model job relays through the browser;
	// otherwise resolve the server-side host that owns the model and dial it
	// directly. If no online host has a server model (e.g. it lives on the Mac
	// and the Mac is asleep/offline), fail fast with a clear message instead of
	// dialing the NAS and getting a bare not-found.
	var mb modelBackend
	if j.local {
		mb = &browserRelay{j: j}
	} else {
		h := s.hosts.onlineHostForModel(j.model)
		if h == nil {
			return fmt.Errorf("model %q is unavailable — its backend may be offline. Try a smaller model or reconnect the host.", j.model)
		}
		mb = &directOllama{chatURL: h.chatURL(), emit: j.emitChunk}
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

	if j.agent {
		allow, sys := s.agentConfig(j)
		return s.runAgentLoop(ctx, mb, j.model, j.email, msgs, allow, sys, j.emitChunk, j.emitPhase, j.emitTool, j.emitQuestions, j.emitThought, j.emitClear, j.addUsage)
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
	// Plain turn: emit an honest phase so a connect-time "queued" hint clears as
	// soon as the worker starts the job. A vision turn reports "vision" — the
	// SigLIP encoder runs before the first token, which takes tens of seconds on
	// the N100, so without this the stale "queued" label (set at enqueue) would
	// mislead the user into thinking another reply is blocking. A text turn
	// reports "answering". The web-search path emits its own "searching" phase.
	j.emitPhase(phaseForImages(hasImages))
	return s.runStreamPass(ctx, mb, j.model, msgs, j.emitChunk)
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

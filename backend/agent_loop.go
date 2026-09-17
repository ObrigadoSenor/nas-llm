package main

import (
	"context"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"
)

// --- Agent harness: a general ReAct loop over a tool registry ---------------
//
// runAgentLoop generalizes runSearchLoop/runClarifyLoop: it gives the model a
// configurable set of tools and drives a bounded Thought→Action→Observation
// loop, streaming the model's text and emitting a per-step trace to the UI.
// web_search and ask_user are registered tools (reusing the existing execution
// helpers), so the agent can compose them with get_time and calculator within a
// single run — something the mutually-exclusive toggle UI could not do.
//
// Small-model guardrails (N100/8 GB): a hard step budget, duplicate-(tool,args)
// detection, error-as-observation (tool failures go back to the model instead
// of crashing the run), and observation size capping. Lean system prompt with
// the current date injected so the model doesn't hallucinate "today".

const (
	agentObsMaxChars      = 4000 // cap a tool observation fed back to the model
	agentOutputMaxChars   = 4096 // cap a command's display-only output stored on the step (reload parity)
	agentDupLimit         = 3    // same tool+args this many times -> nudge to answer
	agentDupLimitStrong   = 6    // strong tier: allow more repeats before nudging
	agentNarrationRetries = 1    // re-prompt a narrating model this many times before accepting prose

	// Context compaction (Tier 3). Triggered when the estimated token count of
	// the running message list crosses 70% of the configured context window.
	agentCompactFrac     = 0.7
	agentToolTrimChars   = 260  // old tool observations are capped to this
	agentTailMin         = 4    // min recent messages kept verbatim on summarize
	agentSummaryMaxChars = 1200 // cap on the generated summary's size
)

// agentStep is one step in the agent trace: a tool call + its outcome. It is
// broadcast to the UI (tool/steps SSE events) and persisted on the assistant
// message so a reload re-paints the trace. Specialized payloads (search/clarify)
// ride along so the existing evidence + question-card UI can render them.
type agentStep struct {
	Step       int          `json:"step"`
	Tool       string       `json:"tool"`
	Args       string       `json:"args,omitempty"`
	Preview    string       `json:"preview,omitempty"`
	IsError    bool         `json:"isError,omitempty"`
	DurationMs int64        `json:"durationMs,omitempty"`
	Search     *searchMeta  `json:"search,omitempty"`
	Clarify    *clarifyMeta `json:"clarify,omitempty"`
	// ExitCode/Output carry a command's exit status and (capped) output for the
	// Warp-style command block: live runs stream via nasllm:toolOutput, and on
	// reload the block body re-paints from Output. Output is display-only and
	// capped (~4 KB); it is NOT fed to the model (the observation is). Cwd/Branch
	// record where the command ran so the block header can show it. All omitempty
	// so old persisted steps round-trip byte-identical. Populated for command-
	// shaped tools (run_command/apply_patch/git_commit/git_push/create_pr).
	ExitCode int    `json:"exitCode,omitempty"`
	Output   string `json:"output,omitempty"`
	Cwd      string `json:"cwd,omitempty"`
	Branch   string `json:"branch,omitempty"`
}

// toolOutcome is the result of executing one tool call.
type toolOutcome struct {
	observation string       // fed back to the model as the tool result ("" if terminal)
	terminal    bool         // if true, the loop stops after this (e.g. ask_user)
	preview     string       // short human-readable preview for the trace
	isError     bool         // mark the step red in the trace
	search      *searchMeta  // web_search evidence (UI)
	clarify     *clarifyMeta // ask_user questions (UI)
	exitCode    int          // command exit status (run_command); 0/absent for non-command tools
	output      string       // capped display-only command output (run_command/apply_patch/...)
	cwd         string       // working directory the command ran in (relayed tools)
	branch      string       // branch the command ran on (relayed tools)
}

// agentTool is one tool the agent may call: an OpenAI tool schema + an executor.
// For server-side tools (web_search, calculator, …) execute runs the tool
// locally. For local file tools (read_file, grep, …) local is true and execute
// is nil — the loop relays execution to the browser via a toolExec SSE event
type agentTool struct {
	schema  oaiTool
	execute func(ctx context.Context, args string) toolOutcome
	local   bool
}

// runAgentLoop drives a bounded ReAct loop over the given tool allowlist. The
// model's text is streamed via emit (for a server backend) or by the browser
// directly (for a relay); each tool call is executed server-side and emitted as
// a trace step (emitTool), with its observation fed back as a tool message
// (error-as-observation: a tool failure becomes the observation text so the
// model can self-correct). ask_user is terminal. The loop stops on: the model
// answering with no tool call, a terminal tool, the step budget, or repeated
// identical calls. On step-budget exhaustion it forces one final answer with
// the tools removed so the model must synthesize.
func (s *server) runAgentLoop(ctx context.Context, mb modelBackend, model, email string, msgs []oaiMessage, allow []string, systemPrompt string,
	emit func(string), emitPhase func(string), emitTool func(agentStep), emitQuestions func(clarifyMeta),
	emitThought func(string), emitClear func(), addUsage func(int, int),
	repoID string, toolExecRelay func(ctx context.Context, step int, tool, args string) toolOutcome,
	pauseRequested func() bool, setRoundCancel func(context.CancelFunc),
	resumeStep int, clarifyBudget int, tier agentTier) error {
	emitPhase("agent")
	reg := s.toolRegistry(email)
	tools := make([]oaiTool, 0, len(allow))
	added := make(map[string]bool, len(allow))
	for _, name := range allow {
		if added[name] {
			continue
		}
		t, ok := reg[name]
		if !ok {
			continue
		}
		// Local (file/edit/git) tools execute via the desktop sidecar relay.
		// Without a relay (a non-repo chat) they cannot run, so don't offer them
		// to the model — offering unusable tools makes the model call them and
		// get a confusing "no relay" error instead of answering. added[] also
		// dedupes when a repo-bound run appends the same tools to the allowlist.
		if t.local && toolExecRelay == nil {
			continue
		}
		added[name] = true
		tools = append(tools, t.schema)
	}
	if len(tools) == 0 {
		// No tools enabled: degenerate to a plain streamed pass.
		emitPhase("answering")
		return s.runStreamPass(ctx, mb, model, msgs, emit)
	}
	// Tier-scaled parameters: strong models get a larger step budget and a
	// higher duplicate-call limit (they can productively use more steps before
	// being forced to synthesize, and a repeat is more likely to be an
	// intentional retry after an error than a small-model loop).
	maxSteps := s.cfg.maxAgentSteps
	dupLimit := agentDupLimit
	if tier == tierStrong {
		maxSteps *= 2
		dupLimit = agentDupLimitStrong
	}
	sys := systemPrompt
	if strings.TrimSpace(sys) == "" {
		if tier == tierStrong {
			sys = agentSystemStrong()
		} else {
			sys = agentSystemNudge()
		}
	}
	// Append the tool-call discipline guardrail for weak/medium models so it
	// always applies in agent mode, even when a custom per-conversation/global
	// system prompt is set — agentConfig only resolves which prompt to use; the
	// guardrail is a safety rule, not a style preference. Strong models emit
	// structured tool calls reliably, so the guardrail is skipped (it would
	// only waste prompt tokens). This block is scoped to the tools-present
	// path (the no-tools degenerate path returned above).
	if tier != tierStrong {
		sys = sys + "\n\n" + toolCallDiscipline()
	}
	messages := append([]oaiMessage{{Role: "system", Content: jsonString(sys)}}, msgs...)
	seen := map[string]int{}
	narrationRetries := 0
	budgetWarned := false
	// Chronic format-mismatch tracking: if the model never emits a structured
	// tool_call AND prose-recovery never executes a call on its behalf (every
	// round lands in the narration guard), emit a one-time trace hint so an
	// invisible chat-template break or a mislabeled tool-capable model surfaces
	// as an actionable signal. A run where prose-recovery did succeed is
	// suppressed: the model is using tools (in prose form, bridged by the
	// parser), so the "disable Agent mode" advice would be wrong.
	proseRecoveries := 0
	narrationHits := 0
	structuredToolCalls := 0
	clarifyRecoveries := 0 // prose clarifying questions bridged to a card this run
	// step is a manual counter (not the for-loop counter) so a narration
	// re-prompt round — which re-runs the model without making progress — does
	// not consume a step of the budget. It increments only at the end of a real
	// (tool-carrying or final-answer) round; the narration guard's continue
	// skips the increment. resumeStep is 0 for a fresh run, or the checkpoint's
	// step index for a resumed run so it continues on the remaining budget.
	step := resumeStep
	// emitFormatHint surfaces a chronic format mismatch at the end of a run. It
	// fires only when the model produced no usable tool call of any kind: zero
	// structured tool_calls AND zero prose-recovered calls, with at least one
	// narration-guard hit — the genuine "tool-capable label is wrong / chat
	// template can't emit calls" dead-end. When prose-recovery succeeded the
	// parser is bridging the model's prose calls into real executions, so the
	// run is functional and the broken-template hint is suppressed.
	emitFormatHint := func() {
		// Suppress when a prose clarifying question was bridged to a card: the
		// model engaged (it asked the user), so the "never emitted a structured
		// tool call / disable Agent mode" advice would be wrong. The genuine
		// dead-end (narration only, no question, no recovery) still surfaces.
		if structuredToolCalls == 0 && proseRecoveries == 0 && clarifyRecoveries == 0 && narrationHits > 0 {
			emitTool(agentStep{Step: step + 1, Tool: "(format)", Preview: "This model never emitted a structured tool call — its chat template may be broken or it may be mislabeled as tool-capable. Consider a different model or disable Agent mode.", IsError: true})
		}
	}
	// runID groups one agent run's captured rounds (opt-in debug capture);
	// round is a monotonic per-Call index so narration re-prompt rounds (which
	// reuse the same step number) still get unique capture filenames.
	runID := newJobID()[:8]
	round := 0
	for step < maxSteps {
		// Pause check between steps: if the user paused the run, stop before
		// driving another inference round. The transcript and step index ride
		// back on a *pausedError so the worker can write a checkpoint; no tool
		// relay is left in flight because pause() also cancels this round's ctx.
		if pauseRequested != nil && pauseRequested() {
			return &pausedError{transcript: messages, step: step}
		}
		// Each round gets its own child ctx so pause() can abort an in-flight
		// inference round (via setRoundCancel) without cancelling the whole
		// job. Cleared at the end of the round; the partial round is discarded.
		roundCtx, roundCancel := context.WithCancel(ctx)
		if setRoundCancel != nil {
			setRoundCancel(roundCancel)
		}
		// Warn once at 80% of the budget so the model knows the cliff is near
		// and finishes outstanding edits before synthesizing, instead of being
		// silently cut off mid-task when the budget forces a final answer.
		if !budgetWarned && step > 0 && step >= (maxSteps*4)/5 {
			budgetWarned = true
			messages = append(messages, oaiMessage{Role: "system", Content: jsonString(fmt.Sprintf("Budget notice: %d tool-call step(s) remain before the run is forced to a final answer. Finish any outstanding edits now, then synthesize your final answer for the user.", maxSteps-step))})
		}
		// Bound the running transcript before each model call so a long multi-step
		// run can't overflow the context window (Tier 3 compaction). A server-side
		// backend compacts against cfg.contextLength (mirrors the NAS
		// OLLAMA_CONTEXT_LENGTH) and summarizes the dropped head via a non-streaming
		// model call. A browser-relay (local-model) backend runs on the visitor's
		// Ollama, whose context the backend can't introspect — it compacts against
		// the conservative cfg.agentRelayContextLength (default 4096, the small-model
		// default) using truncation only (no summary, which would stream an internal
		// summary into the bubble and cost an extra round on the visitor's Ollama).
		switch mbT := mb.(type) {
		case *directOllama:
			messages = s.maybeCompact(roundCtx, mbT.chatURL, model, messages, s.cfg.contextLength, true)
		case *browserRelay:
			messages = s.maybeCompact(roundCtx, "", model, messages, s.cfg.agentRelayContextLength, false)
		}
		// One inference round. For a server backend, content streams live to the
		// answer bubble as it arrives; for a browser relay, the browser streams it
		// directly from localhost (the backend does not re-emit chunks). The
		// returned content drives thinking-round handling below.
		round++
		if s.cfg.agentDebugCapture {
			backend, sampling := agentBackendInfo(mb)
			s.captureAgentRound(runID, backend, model, step, round, messages, tools, sampling)
		}
		msg, usage, err := mb.Call(roundCtx, model, messages, tools)
		if err != nil {
			roundCancel()
			if setRoundCancel != nil {
				setRoundCancel(nil)
			}
			// An aborted round may be a pause (pauseRequested) rather than a real
			// error — surface the sentinel so the worker checkpoints instead of
			// finalizing as an error.
			if pauseRequested != nil && pauseRequested() {
				return &pausedError{transcript: messages, step: step}
			}
			return fmt.Errorf("agent step %d: %w", step+1, err)
		}
		if addUsage != nil {
			addUsage(usage.PromptTokens, usage.CompletionTokens)
		}
		roundText := contentText(msg.Content)
		if len(msg.ToolCalls) > 0 {
			structuredToolCalls++
		}
		if len(msg.ToolCalls) == 0 {
			// Strong tier: a model that reliably emits structured tool_calls has
			// given a genuine final answer — skip the small-model recovery/guard
			// path (prose recovery, narration guard, awaiting fallback, format
			// hint) and accept it directly.
			if tier == tierStrong {
				emitPhase("answering")
				if step == 0 {
					emitTool(agentStep{Step: 1, Tool: "(direct)", Preview: "Answered directly — no tools were needed."})
				}
				if roundText == "" {
					emit("(no response)")
				}
				roundCancel()
				return nil
			}
			// Prose tool-call recovery: a small model that reports a tools
			// capability but can't emit structured tool_calls deltas often
			// writes the call as a JSON block in prose ("I'll list the files:
			// ```{ "name": "list_files", "arguments": {"path":"src"} }```").
			// The narration guard's re-prompt can't fix this — the model
			// physically can't switch to the structured format — so parse the
			// JSON out of the prose and execute it as a real tool call. The run
			// then continues with a real observation instead of dead-ending on
			// the narration. Only the first parseable call to an offered tool is
			// recovered (the model often writes it twice); the preamble stays as
			// thinking. If no parseable call is found, fall through to the
			// narration guard / final-answer path.
			if tc, ok := extractProseToolCall(roundText, added); ok {
				proseRecoveries++
				msg.ToolCalls = []oaiToolCall{tc}
				// Strip the recovered JSON tool-call blob (and any fenced code-block
				// wrapper around it) from the thinking text so the raw
				// {"name":"...","arguments":{...}} syntax never reaches the thinking
				// drawer — the user sees the model's reasoning, then the command
				// block, not the raw tool-call JSON in between.
				roundText = stripProseToolCallText(roundText, added)
				// Fall through to the tool-execution path below (do not return):
				// the preamble is moved to thinking and the recovered call runs
				// exactly like a real one.
			} else {
				// Prose clarifying-question bridge: a model that can't emit
				// structured tool_calls (a broken chat template, or a mislabeled
				// model) often asks the user a question in prose ("Sure, I'll
				// commit the changes. What commit message would you like?")
				// instead of calling ask_user. The narration guard below would
				// re-prompt that as a failed doing-tool ("emit a structured tool
				// call NOW … git_commit") and dead-end on the (format) "disable
				// Agent mode" diagnostic. When ask_user is offered and the turn
				// reads as a question the model needs answered to proceed, surface
				// it as an interactive clarify card (single-select if options
				// extract, else free-text) and end the run — the user's answer
				// re-enters /generate as a new turn. Bounded by clarifyBudget so
				// the agent cannot stall on endless back-to-back prose questions.
				if clarifyBudget > 0 {
					if meta := detectAgentClarifyQuestion(roundText, added["ask_user"]); meta != nil {
						clarifyRecoveries++
						if roundText != "" {
							emitThought(roundText)
						}
						emitClear()
						emitQuestions(*meta)
						emitPhase("clarifying")
						roundCancel()
						return nil
					}
				}
				// Narration guard: a small local model often describes what it
				// would do ("I'll edit foo.go to...") instead of emitting a
				// structured tool_call. Without this guard the loop treats that
				// prose as the final answer and returns at step 0 — the "agent
				// explains but never does anything" symptom. When no tool has run
				// yet (step == 0) and the text reads like an intention/plan, move
				// the narration to the thinking drawer and feed back a corrective
				// system message forcing a real tool call, then re-run. Bounded to
				// agentNarrationRetries so a model that keeps narrating eventually
				// falls through to a real answer instead of looping. A genuine
				// final answer (no first-person intention phrasing) returns as
				// before. This runs only when prose-recovery found nothing to
				// execute — pure intention prose with no JSON tool call.
				// Also catch second-person "hand me the tool output / run this for
				// me" prose (looksLikeAwaitingToolResult) — the dead-end that
				// neither prose-recovery nor the intention-narration guard matches.
				awaiting := looksLikeAwaitingToolResult(roundText)
				if step == 0 && (looksLikeNarration(roundText) || awaiting) && narrationRetries < agentNarrationRetries {
					narrationRetries++
					narrationHits++
					if roundText != "" {
						emitThought(roundText)
					}
					emitClear()
					messages = append(messages, msg, oaiMessage{Role: "system", Content: jsonString(awaitingToolNudge(awaiting, added))})
					roundCancel()
					continue
				}
				// Interactive fallback: the model asked the user to hand it a tool
				// output or run a command for it even after the re-prompt, or on a
				// later step. Don't stream that dead-end prose as the answer —
				// surface a clickable "proceed" clarify card (reusing the ask_user
				// card UI + answer path) so the user can nudge the agent back to
				// running its tools itself. Pure narration that exhausted the guard
				// falls through to the normal final-answer path below, unchanged.
				if awaiting {
					emitClear()
					emitQuestions(synthesizeProceedCard(roundText))
					emitPhase("clarifying")
					roundCancel()
					return nil
				}
				// Final answer — its content was already streamed (server backend)
				// or rendered by the browser (relay), and stays in the bubble +
				// j.content (the answer, not thinking).
				emitPhase("answering")
				// If the model answered on its very first turn without ever calling a
				// tool, surface that as a trace step so a tool-capable model
				// declining to use tools reads as model behavior, not a silent
				// "agent did nothing". Skip the marker when a narration re-prompt
				// preceded the answer (narrationRetries > 0): that's a stalling
				// model that exhausted the guard, not a genuine direct answer, and
				// because narration no longer consumes a step the second narration
				// still lands at step 0.
				if step == 0 && narrationRetries == 0 {
					emitTool(agentStep{Step: 1, Tool: "(direct)", Preview: "Answered directly — no tools were needed."})
				}
				if roundText == "" {
					emit("(no response)")
				}
				emitFormatHint()
				roundCancel()
				return nil
			}
		}
		// Thinking round (had tool calls): move this round's text to the thinking
		// drawer and clear the answer bubble so it ends up holding only the final
		// synthesized answer. This separates the model's reasoning (thinking) from
		// its synthesized answer.
		if roundText != "" {
			emitThought(roundText)
		}
		emitClear()
		// Append the assistant turn (thought + tool_calls) for the next round.
		messages = append(messages, msg)
		for _, tc := range msg.ToolCalls {
			tool, ok := reg[tc.Function.Name]
			if !ok {
				obs := "Unknown tool: " + tc.Function.Name + ". Available tools: " + strings.Join(allow, ", ")
				emitTool(agentStep{Step: step + 1, Tool: tc.Function.Name, Args: tc.Function.Arguments, Preview: "unknown tool", IsError: true})
				messages = append(messages, toolResultMsg(tc, obs, true))
				continue
			}
			emitPhase("tool:" + tc.Function.Name)
			// Duplicate-(tool,args) detection: nudge the model to stop and answer
			// rather than feeding it another real observation to loop over.
			key := tc.Function.Name + "\x00" + tc.Function.Arguments
			seen[key]++
			if seen[key] >= dupLimit {
				obs := fmt.Sprintf("You have called %s with these arguments %d times. Do not call it again with the same arguments; synthesize your final answer from what you already know.", tc.Function.Name, seen[key])
				emitTool(agentStep{Step: step + 1, Tool: tc.Function.Name, Args: tc.Function.Arguments, Preview: "repeated call — nudge to answer", IsError: true})
				messages = append(messages, toolResultMsg(tc, obs, true))
				continue
			}
			// Validate arguments against the tool schema before executing. Small models
			// often emit malformed/empty args; a corrective observation lets them
			// self-correct instead of crashing the run (Tier 3 hardening).
			if verr := validateToolArgs(tool, tc.Function.Arguments); verr != nil {
				emitTool(agentStep{Step: step + 1, Tool: tc.Function.Name, Args: tc.Function.Arguments, Preview: "bad args: " + trimPreview(verr.Error()), IsError: true})
				messages = append(messages, toolResultMsg(tc, "Your call to "+tc.Function.Name+" failed validation: "+verr.Error()+". Fix the arguments and call it again, or proceed without it.", true))
				continue
			}
			start := time.Now()
			var out toolOutcome
			if tool.local && toolExecRelay != nil {
				out = toolExecRelay(roundCtx, step+1, tc.Function.Name, tc.Function.Arguments)
			} else if !tool.local {
				out = tool.execute(ctx, tc.Function.Arguments)
			} else {
				out = toolOutcome{observation: "Local tool " + tc.Function.Name + " has no executor and no relay is configured.", preview: "no executor", isError: true}
			}
			dur := time.Since(start).Milliseconds()
			st := agentStep{Step: step + 1, Tool: tc.Function.Name, Args: tc.Function.Arguments, Preview: out.preview, IsError: out.isError, DurationMs: dur, ExitCode: out.exitCode, Output: out.output, Cwd: out.cwd, Branch: out.branch}
			if out.search != nil {
				st.Search = out.search
			}
			if out.clarify != nil {
				st.Clarify = out.clarify
			}
			emitTool(st)
			if out.terminal {
				// ask_user: stash the question card on the job (emitQuestions) so the
				// worker persists it as a clarifying turn, and the step's Clarify
				// payload lets the UI paint the card from the trace too. The preamble
				// streamed this round is thinking, not the answer — clear the bubble so
				// the question card (rendered by the questions event) owns it cleanly.
				if roundText != "" {
					emitThought(roundText)
				}
				emitClear()
				if out.clarify != nil {
					emitQuestions(*out.clarify)
				}
				emitPhase("clarifying")
				roundCancel()
				return nil
			}
			messages = append(messages, toolResultMsg(tc, capObservation(out.observation, agentObsMaxChars), out.isError))
		}
		roundCancel()
		if setRoundCancel != nil {
			setRoundCancel(nil)
		}
		step++
		// Pause check after the round's tools completed and the step counter
		// advanced: the transcript is consistent (every tool call has its result)
		// and no relay is in flight, so this is the clean checkpoint point. step
		// now equals the number of completed rounds, so a resumed run starting
		// at it continues on exactly the remaining budget.
		if pauseRequested != nil && pauseRequested() {
			return &pausedError{transcript: messages, step: step}
		}
	}
	// Step budget exhausted: force one final answer with tools removed so the
	// model must synthesize. Routed through the backend so a server backend
	// streams it live and a browser relay has the browser stream it from localhost.
	// Surface a trace step so the truncation is visible in the UI instead of a
	// silent "agent stopped calling tools and answered".
	emitTool(agentStep{Step: step + 1, Tool: "(budget)", Preview: fmt.Sprintf("step budget exhausted — forcing a final answer (%d steps).", maxSteps)})
	emitFormatHint()
	emitPhase("answering")
	_, _, err := mb.Call(ctx, model, messages, nil)
	return err
}

// toolResultMsg builds an OpenAI tool-result message. Ollama's OpenAI shim does
// not honor an is_error field, so errors are prefix-tagged so a model that
// would otherwise treat a short failure string as a real observation sees it.
// For a failed write tool, append that the file is unchanged and that repeating
// the identical call will fail again — a small model often treats a short
// "Could not write X" as if the edit landed and moves on (the "it skips steps"
// symptom). Skipped when the observation already says "unchanged" (the sidecar's
// edit_file/apply_patch failure messages do) to avoid duplicating it.
func toolResultMsg(tc oaiToolCall, content string, isError bool) oaiMessage {
	if isError {
		content = "Error: " + content
		if isWriteTool(tc.Function.Name) && !strings.Contains(content, "unchanged") {
			content += "\nThe file is unchanged. Do not repeat the identical call — it will fail the same way; adjust the arguments or use a different file tool."
		}
	}
	return oaiMessage{Role: "tool", ToolCallID: tc.ID, Name: tc.Function.Name, Content: jsonString(content)}
}

// isWriteTool reports whether a tool mutates the working tree, so a failed
// observation can stress that the file is unchanged (vs. a read or command
// failure, which doesn't carry that meaning).
func isWriteTool(name string) bool {
	switch name {
	case "write_file", "edit_file", "move_path", "delete_path", "apply_patch":
		return true
	}
	return false
}

func capObservation(s string, max int) string {
	s = strings.TrimSpace(s)
	if len(s) <= max {
		return s
	}
	return s[:max] + "\n…[truncated]"
}

func trimPreview(s string) string {
	s = strings.TrimSpace(strings.Join(strings.Fields(s), " "))
	if len(s) > 120 {
		return s[:120] + "…"
	}
	return s
}

func shortQuery(q string) string {
	q = strings.TrimSpace(q)
	if len(q) > 60 {
		return q[:60] + "…"
	}
	return q
}

func formatNum(v float64) string {
	if math.IsInf(v, 0) {
		return "infinity"
	}
	if math.IsNaN(v) {
		return "NaN"
	}
	if v == math.Trunc(v) && math.Abs(v) < 1e15 {
		return strconv.FormatFloat(v, 'f', -1, 64)
	}
	return strconv.FormatFloat(v, 'f', 6, 64)
}

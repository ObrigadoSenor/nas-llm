package main

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// TestAgentSystemPromptInjection verifies that runAgentLoop prepends the
// resolved system prompt as the first message (role "system") of every model
// round, and that agentConfig resolves the prompt in the documented order:
// per-conversation override → global settings → built-in agentSystemNudge().
//
// It uses a local (browser-relay) agent job so the backend trusts the
// supportsTools verdict without a real Ollama, and inspects the modelCall SSE
// event the relay emits — whose Messages field is exactly the list handed to
// mb.Call (system prompt + conversation turns). The browser "answers" directly
// on round 1 (no tool_calls) so the loop finishes cleanly after the assertion.
func TestAgentSystemPromptInjection(t *testing.T) {
	cases := []struct {
		name      string
		convSys   string // per-conversation agent_system override ("" = none)
		globalSys string // global settings agent_system ("" = none)
		want      string // expected system message content (asserted as a substring:
		// runAgentLoop appends the tool-call discipline guardrail after it, so the
		// prompt is no longer byte-equal to the configured value)
	}{
		{
			name:      "per-conversation override wins over global and default",
			convSys:   "You are a test agent. Always reply with PONG.",
			globalSys: "You are a global agent. Be terse.",
			want:      "You are a test agent. Always reply with PONG.",
		},
		{
			name:      "global setting wins when no per-conversation override",
			globalSys: "You are a global test agent. Be terse.",
			want:      "You are a global test agent. Be terse.",
		},
		{
			name: "built-in default nudge when nothing configured",
			want: "You are a capable agent running on a small local server.",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			// Fresh store per case so a global setting from one case can't leak
			// into another.
			st, err := newStore(filepath.Join(t.TempDir(), "test.db"))
			if err != nil {
				t.Fatalf("newStore: %v", err)
			}
			defer st.close()
			srv := &server{cfg: config{contextLength: 8192, maxAgentSteps: 2}, store: st}
			srv.jobs = newJobManager(st, srv)

			const email = "user@example.com"
			// Stable, short id per case (the literal is only used as a row key).
			convID := "conv-sys-" + map[string]string{
				"per-conversation override wins over global and default": "conv",
				"global setting wins when no per-conversation override":  "global",
				"built-in default nudge when nothing configured":         "default",
			}[c.name]

			if _, err := st.createConversation(email, convID, "t", "local:1b",
				[]Message{{Role: "user", Content: "ping"}}); err != nil {
				t.Fatalf("createConversation: %v", err)
			}
			if c.convSys != "" {
				sys := c.convSys
				if _, err := st.patchConversation(email, convID, nil, nil, nil, &sys, nil, nil, nil, nil, nil, nil, nil, nil); err != nil {
					t.Fatalf("patchConversation: %v", err)
				}
			}
			if c.globalSys != "" {
				if err := st.setSetting("agent_system", c.globalSys); err != nil {
					t.Fatalf("setSetting: %v", err)
				}
			}

			j := newJob(convID, email, "local:1b", false, false, true) // agent=true
			j.local = true
			j.supportsTools = true // tool-capable local model: backend trusts this for local jobs

			ch, _ := j.subscribe()
			defer j.unsubscribe(ch)
			if err := srv.jobs.enqueue(j); err != nil {
				t.Fatalf("enqueue: %v", err)
			}

			// The worker arms the pending relay channel, then emits a modelCall
			// whose Messages[0] is the injected system prompt.
			waitForRelay(t, j, 5*time.Second)
			var sysMsg oaiMessage
			sawModelCall := false
			for !sawModelCall {
				ev := nextEvent(t, ch, 5*time.Second)
				if ev.kind != "modelCall" {
					continue
				}
				var mc modelCallPayload
				if err := json.Unmarshal([]byte(ev.text), &mc); err != nil {
					t.Fatalf("unmarshal modelCall: %v", err)
				}
				if len(mc.Messages) == 0 {
					t.Fatalf("modelCall carried no messages")
				}
				sysMsg = mc.Messages[0]
				sawModelCall = true
			}

			if sysMsg.Role != "system" {
				t.Fatalf("messages[0].Role = %q, want %q", sysMsg.Role, "system")
			}
			got := contentText(sysMsg.Content)
			// The configured/default prompt is now a prefix: runAgentLoop appends the
			// tool-call discipline guardrail, so check it as a substring rather than
			// for byte equality, then assert the guardrail is present in every case.
			if !strings.Contains(got, c.want) {
				t.Errorf("system prompt = %q, want it to contain %q", got, c.want)
			}
			if !strings.Contains(got, "never invent a tool result") {
				t.Errorf("system prompt missing the tool-call discipline guardrail: %q", got)
			}

			// Let the loop finish: the browser POSTs a final answer with no
			// tool_calls, so the agent loop returns on step 0.
			claimRelay(t, j, relayResponse{content: "PONG"})
			select {
			case <-j.finished:
			case <-time.After(5 * time.Second):
				t.Fatalf("agent job did not finalize after the direct answer")
			}
			if status, _, _ := j.snapshot(); status != "done" {
				t.Errorf("job status = %q, want %q", status, "done")
			}
		})
	}
}

// TestAgentSystemPromptInjection_OnlyAppliesToAgentMode guards the documented
// scope: the configurable agent_system setting is an agent-harness concern. A
// plain (non-agent) turn carries only the short built-in plainChatNudge (a
// style hint) as a leading system message, and must NEVER leak the global
// agent_system setting. This keeps the harness boundary explicit: the
// configurable prompt does not widen into plain chat.
func TestAgentSystemPromptInjection_OnlyAppliesToAgentMode(t *testing.T) {
	st, err := newStore(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("newStore: %v", err)
	}
	defer st.close()
	srv := &server{cfg: config{contextLength: 8192, askUserInPlainChat: false}, store: st}
	srv.jobs = newJobManager(st, srv)

	if err := st.setSetting("agent_system", "SECRET AGENT PROMPT"); err != nil {
		t.Fatalf("setSetting: %v", err)
	}

	const email = "user@example.com"
	convID := "conv-plain"
	if _, err := st.createConversation(email, convID, "t", "local:1b",
		[]Message{{Role: "user", Content: "hi"}}); err != nil {
		t.Fatalf("createConversation: %v", err)
	}

	j := newJob(convID, email, "local:1b", false, false, false) // plain turn
	j.local = true
	j.supportsTools = false // non-tool plain turn: skips ask_user pass → bare stream

	ch, _ := j.subscribe()
	defer j.unsubscribe(ch)
	if err := srv.jobs.enqueue(j); err != nil {
		t.Fatalf("enqueue: %v", err)
	}

	waitForRelay(t, j, 5*time.Second)
	var mc modelCallPayload
	sawModelCall := false
	for !sawModelCall {
		ev := nextEvent(t, ch, 5*time.Second)
		if ev.kind != "modelCall" {
			continue
		}
		if err := json.Unmarshal([]byte(ev.text), &mc); err != nil {
			t.Fatalf("unmarshal modelCall: %v", err)
		}
		sawModelCall = true
	}

	// A plain turn carries the built-in plainChatNudge as a leading system
	// message, but must NEVER leak the configurable agent_system setting (that
	// is an agent-harness concern).
	var sawNudge bool
	for i, m := range mc.Messages {
		if m.Role == "system" {
			if i != 0 {
				t.Errorf("plain turn system nudge should be messages[0], got index %d", i)
			}
			if strings.Contains(contentText(m.Content), "SECRET AGENT PROMPT") {
				t.Errorf("plain turn leaked the agent_system setting at messages[%d]: %q", i, contentText(m.Content))
			}
			if strings.Contains(contentText(m.Content), "follow-up question") {
				sawNudge = true
			}
		}
	}
	if !sawNudge {
		t.Errorf("plain turn did not inject the built-in plainChatNudge; messages=%+v", mc.Messages)
	}

	claimRelay(t, j, relayResponse{content: "hello"})
	select {
	case <-j.finished:
	case <-time.After(5 * time.Second):
		t.Fatalf("plain job did not finalize")
	}
}

// fakeBackend is a scripted modelBackend for runAgentLoop tests: it returns a
// fixed sequence of assistant messages (one per Call), so a test can simulate a
// model that narrates on round 1 and emits a real tool_call on round 2 without
// any live Ollama. calls counts how many rounds were actually run. recorded
// captures the messages handed to each Call so a test can inspect injected
// system messages (e.g. the 80% budget warning).
type fakeBackend struct {
	mu        sync.Mutex
	responses []oaiMessage
	calls     int
	recorded  [][]oaiMessage
}

func (f *fakeBackend) Call(ctx context.Context, model string, messages []oaiMessage, tools []oaiTool) (oaiMessage, agentUsage, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	cp := make([]oaiMessage, len(messages))
	copy(cp, messages)
	f.recorded = append(f.recorded, cp)
	if f.calls >= len(f.responses) {
		// Past the end of the script: return a clean terminal answer so the loop
		// doesn't hang or loop forever on a test that under-scripted the rounds.
		f.calls++
		return oaiMessage{Role: "assistant", Content: jsonString("(test exhausted)")}, agentUsage{}, nil
	}
	resp := f.responses[f.calls]
	f.calls++
	return resp, agentUsage{}, nil
}

func (f *fakeBackend) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

func narrationMsg(text string) oaiMessage {
	return oaiMessage{Role: "assistant", Content: jsonString(text)}
}

func toolCallMsg(id, name, args string) oaiMessage {
	var tc oaiToolCall
	tc.ID = id
	tc.Type = "function"
	tc.Function.Name = name
	tc.Function.Arguments = args
	return oaiMessage{Role: "assistant", ToolCalls: []oaiToolCall{tc}}
}

func finalAnswerMsg(text string) oaiMessage {
	return oaiMessage{Role: "assistant", Content: jsonString(text)}
}

// TestAgentNarrationGuard verifies the loop's narration guard: when a small
// model narrates a tool call as prose ("I'll edit foo.go ...") instead of
// emitting a structured tool_call, the loop does NOT accept that prose as the
// final answer and return at step 0. It moves the narration to the thinking
// drawer, feeds back a corrective system message, and re-runs so the model
// actually calls the tool next round. Bounded so a model that keeps narrating
// eventually falls through to a real answer instead of looping.
func TestAgentNarrationGuard(t *testing.T) {
	const email = "user@example.com"
	msgs := []oaiMessage{{Role: "user", Content: jsonString("Add a comment to foo.go")}}

	t.Run("narrates then tool-calls: guard recovers and the tool runs", func(t *testing.T) {
		st, err := newStore(filepath.Join(t.TempDir(), "test.db"))
		if err != nil {
			t.Fatalf("newStore: %v", err)
		}
		defer st.close()
		srv := &server{cfg: config{contextLength: 8192, maxAgentSteps: 6}, store: st}

		mb := &fakeBackend{responses: []oaiMessage{
			narrationMsg("I'll edit foo.go to add a comment."), // round 1: narrates
			toolCallMsg("call_1", "get_time", "{}"),            // round 2: real tool call
			finalAnswerMsg("Done - added the comment."),        // round 3: synthesized answer
		}}

		var (
			steps    []agentStep
			thoughts []string
			phases   []string
		)
		err = srv.runAgentLoop(context.Background(), mb, "test-model", email, msgs, []string{"get_time"}, "",
			func(string) {}, func(p string) { phases = append(phases, p) },
			func(st agentStep) { steps = append(steps, st) }, func(clarifyMeta) {},
			func(s string) { thoughts = append(thoughts, s) }, func() {}, func(int, int) {}, "", nil, nil, nil, 0)
		if err != nil {
			t.Fatalf("runAgentLoop: %v", err)
		}
		if got := mb.callCount(); got != 3 {
			t.Fatalf("model calls = %d, want 3 (narration -> tool call -> answer)", got)
		}
		if len(thoughts) == 0 || !strings.Contains(thoughts[0], "I'll edit foo.go") {
			t.Errorf("thoughts = %v, want the narration moved to thinking", thoughts)
		}
		var ranTool *agentStep
		for i := range steps {
			if steps[i].Tool == "get_time" {
				ranTool = &steps[i]
			}
		}
		if ranTool == nil {
			t.Errorf("no get_time tool step emitted; steps = %+v", steps)
		}
		for _, st := range steps {
			if st.Tool == "(direct)" {
				t.Errorf("a (direct) step was emitted, meaning narration was accepted as the final answer: %+v", st)
			}
		}
		if len(phases) == 0 || phases[len(phases)-1] != "answering" {
			t.Errorf("last phase = %v, want answering", phases)
		}
	})

	t.Run("narrates twice: guard exhausts and accepts the second narration", func(t *testing.T) {
		st, err := newStore(filepath.Join(t.TempDir(), "test.db"))
		if err != nil {
			t.Fatalf("newStore: %v", err)
		}
		defer st.close()
		srv := &server{cfg: config{contextLength: 8192, maxAgentSteps: 6}, store: st}

		mb := &fakeBackend{responses: []oaiMessage{
			narrationMsg("I'll edit foo.go to add a comment."), // round 1: re-prompted
			narrationMsg("I'll change bar.go too."),            // round 2: budget exhausted -> accept
		}}

		var steps []agentStep
		err = srv.runAgentLoop(context.Background(), mb, "test-model", email, msgs, []string{"get_time"}, "",
			func(string) {}, func(string) {}, func(st agentStep) { steps = append(steps, st) },
			func(clarifyMeta) {}, func(string) {}, func() {}, func(int, int) {}, "", nil, nil, nil, 0)
		if err != nil {
			t.Fatalf("runAgentLoop: %v", err)
		}
		if got := mb.callCount(); got != 2 {
			t.Fatalf("model calls = %d, want 2", got)
		}
		for _, st := range steps {
			if st.Tool == "get_time" || st.Tool == "(direct)" {
				t.Errorf("unexpected step %+v; the guard should exhaust without a tool or a step-0 direct marker", st)
			}
		}
	})

	t.Run("genuine direct answer: guard leaves it alone", func(t *testing.T) {
		st, err := newStore(filepath.Join(t.TempDir(), "test.db"))
		if err != nil {
			t.Fatalf("newStore: %v", err)
		}
		defer st.close()
		srv := &server{cfg: config{contextLength: 8192, maxAgentSteps: 6}, store: st}

		// No first-person intention phrasing — the guard must not re-prompt, and
		// the loop returns at step 0 with a (direct) step.
		mb := &fakeBackend{responses: []oaiMessage{finalAnswerMsg("The file foo.go already has a comment.")}}

		var (
			steps    []agentStep
			thoughts []string
		)
		err = srv.runAgentLoop(context.Background(), mb, "test-model", email, msgs, []string{"get_time"}, "",
			func(string) {}, func(string) {}, func(st agentStep) { steps = append(steps, st) },
			func(clarifyMeta) {}, func(s string) { thoughts = append(thoughts, s) }, func() {}, func(int, int) {}, "", nil, nil, nil, 0)
		if err != nil {
			t.Fatalf("runAgentLoop: %v", err)
		}
		if got := mb.callCount(); got != 1 {
			t.Fatalf("model calls = %d, want 1 (genuine direct answer, no re-prompt)", got)
		}
		if len(thoughts) != 0 {
			t.Errorf("thoughts = %v, want none (a direct answer is not narration)", thoughts)
		}
		var direct *agentStep
		for i := range steps {
			if steps[i].Tool == "(direct)" {
				direct = &steps[i]
			}
		}
		if direct == nil {
			t.Errorf("no (direct) step emitted; a genuine direct answer should produce one. steps = %+v", steps)
		}
	})
}

// TestAgentProseToolCallRecovery verifies the prose-recovery path: when a small
// model writes a tool call as a JSON block in prose (the real-world failure
// mode behind "the agent explains but never does anything"), the loop parses
// the JSON out of the prose and executes it as a real tool call instead of
// dead-ending on the narration. This is the fix for a model that reports a
// tools capability but can't emit structured tool_calls deltas.
func TestAgentProseToolCallRecovery(t *testing.T) {
	const email = "user@example.com"
	msgs := []oaiMessage{{Role: "user", Content: jsonString("What time is it?")}}

	t.Run("recovers a tool call written as JSON in prose and runs it", func(t *testing.T) {
		st, err := newStore(filepath.Join(t.TempDir(), "test.db"))
		if err != nil {
			t.Fatalf("newStore: %v", err)
		}
		defer st.close()
		srv := &server{cfg: config{contextLength: 8192, maxAgentSteps: 6}, store: st}

		// The model writes the call as prose (a JSON block) instead of emitting
		// structured tool_calls — exactly the reported dead-end pattern. The
		// call is even duplicated, as small models often do.
		narrated := "Sure, let's check the time.\n\n```\n{ \"name\": \"get_time\", \"arguments\": {} }\n```\n{\"name\":\"get_time\",\"arguments\":{}}"
		mb := &fakeBackend{responses: []oaiMessage{
			narrationMsg(narrated),      // round 1: narrates the call as JSON prose
			finalAnswerMsg("It's 3pm."), // round 2: synthesizes after the real observation
		}}

		var (
			steps    []agentStep
			thoughts []string
		)
		err = srv.runAgentLoop(context.Background(), mb, "test-model", email, msgs, []string{"get_time"}, "",
			func(string) {}, func(string) {}, func(st agentStep) { steps = append(steps, st) },
			func(clarifyMeta) {}, func(s string) { thoughts = append(thoughts, s) }, func() {}, func(int, int) {}, "", nil, nil, nil, 0)
		if err != nil {
			t.Fatalf("runAgentLoop: %v", err)
		}
		// Round 1 narrated (recovered -> tool ran) + round 2 synthesized = 2 calls.
		if got := mb.callCount(); got != 2 {
			t.Fatalf("model calls = %d, want 2 (recovered tool ran, then synthesized answer)", got)
		}
		// The narrated preamble must be in the thinking drawer, not the answer.
		if len(thoughts) == 0 || !strings.Contains(thoughts[0], "let's check the time") {
			t.Errorf("thoughts = %v, want the narration moved to thinking", thoughts)
		}
		// A real get_time step must have run (the recovery executed it).
		var ranTool *agentStep
		for i := range steps {
			if steps[i].Tool == "get_time" {
				ranTool = &steps[i]
			}
		}
		if ranTool == nil {
			t.Fatalf("no get_time tool step emitted; prose-recovery should have run it. steps = %+v", steps)
		}
		if ranTool.IsError {
			t.Errorf("recovered get_time step errored: %+v", ranTool)
		}
		// No (direct) step — the narration was NOT accepted as the final answer.
		for _, st := range steps {
			if st.Tool == "(direct)" {
				t.Errorf("a (direct) step was emitted, meaning the narration dead-ended: %+v", st)
			}
		}
	})

	t.Run("no parseable call in prose: falls through to narration guard", func(t *testing.T) {
		st, err := newStore(filepath.Join(t.TempDir(), "test.db"))
		if err != nil {
			t.Fatalf("newStore: %v", err)
		}
		defer st.close()
		srv := &server{cfg: config{contextLength: 8192, maxAgentSteps: 6}, store: st}

		// Pure intention prose, no JSON tool call — recovery finds nothing, so
		// the narration guard re-prompts once, then accepts the second narration.
		mb := &fakeBackend{responses: []oaiMessage{
			narrationMsg("I'll check the time for you."), // round 1: no JSON -> re-prompt
			narrationMsg("I'll check it now."),           // round 2: budget exhausted -> accept
		}}

		var steps []agentStep
		err = srv.runAgentLoop(context.Background(), mb, "test-model", email, msgs, []string{"get_time"}, "",
			func(string) {}, func(string) {}, func(st agentStep) { steps = append(steps, st) },
			func(clarifyMeta) {}, func(string) {}, func() {}, func(int, int) {}, "", nil, nil, nil, 0)
		if err != nil {
			t.Fatalf("runAgentLoop: %v", err)
		}
		if got := mb.callCount(); got != 2 {
			t.Fatalf("model calls = %d, want 2 (re-prompt then accept)", got)
		}
		for _, st := range steps {
			if st.Tool == "get_time" {
				t.Errorf("get_time ran without a parseable call; recovery should not have fired. %+v", st)
			}
		}
	})
}

// TestAgentAwaitingToolResultFallback verifies the prose-dead-end fix: when a
// tool-capable model writes second-person request prose ("Please provide the
// output from the tool response so I can proceed…") instead of a structured
// tool_call, the loop does NOT stream that prose to the user as the answer.
// It re-prompts once (nudge to emit a real tool call, which the loop then runs
// autonomously), and if the model still stalls it surfaces a clickable
// "proceed" clarify card via emitQuestions so the user can nudge the agent
// back to running its tools itself.
func TestAgentAwaitingToolResultFallback(t *testing.T) {
	const email = "user@example.com"
	msgs := []oaiMessage{{Role: "user", Content: jsonString("Update the settings menu.")}}

	t.Run("awaiting prose twice: re-prompt then proceed card", func(t *testing.T) {
		st, err := newStore(filepath.Join(t.TempDir(), "test.db"))
		if err != nil {
			t.Fatalf("newStore: %v", err)
		}
		defer st.close()
		srv := &server{cfg: config{contextLength: 8192, maxAgentSteps: 6}, store: st}

		deadEnd := "Please provide the output from the tool response so I can proceed with updating the settings menu."
		mb := &fakeBackend{responses: []oaiMessage{
			narrationMsg(deadEnd), // round 1: awaiting -> re-prompt
			narrationMsg(deadEnd), // round 2: exhausted -> proceed card
		}}

		var (
			steps     []agentStep
			thoughts  []string
			phases    []string
			emitted   []string
			questions []clarifyMeta
		)
		err = srv.runAgentLoop(context.Background(), mb, "test-model", email, msgs, []string{"get_time"}, "",
			func(s string) { emitted = append(emitted, s) },
			func(p string) { phases = append(phases, p) },
			func(st agentStep) { steps = append(steps, st) },
			func(c clarifyMeta) { questions = append(questions, c) },
			func(s string) { thoughts = append(thoughts, s) },
			func() {},
			func(int, int) {},
			"", nil, nil, nil, 0)
		if err != nil {
			t.Fatalf("runAgentLoop: %v", err)
		}
		// Round 1 re-prompted + round 2 accepted via proceed card = 2 calls.
		if got := mb.callCount(); got != 2 {
			t.Fatalf("model calls = %d, want 2 (re-prompt then proceed card)", got)
		}
		// A proceed card must have been emitted with the agent's prose.
		if len(questions) != 1 || len(questions[0].Questions) != 1 {
			t.Fatalf("questions = %+v, want one proceed card with one question", questions)
		}
		if !strings.Contains(questions[0].Questions[0].Text, "provide the output from the tool response") {
			t.Errorf("proceed card text = %q, want the agent's dead-end prose", questions[0].Questions[0].Text)
		}
		// The dead-end prose must NOT be streamed to the user as the answer.
		for _, e := range emitted {
			if strings.Contains(e, "provide the output from the tool response") {
				t.Errorf("dead-end prose was streamed to the user: %q", e)
			}
		}
		// No (direct) step — the prose was not accepted as a genuine answer.
		for _, st := range steps {
			if st.Tool == "(direct)" {
				t.Errorf("a (direct) step was emitted, meaning the dead-end was accepted as the answer: %+v", st)
			}
		}
		// Phase ends in clarifying (the proceed card).
		if len(phases) == 0 || phases[len(phases)-1] != "clarifying" {
			t.Errorf("last phase = %v, want clarifying", phases)
		}
		// Round 1's prose moved to the thinking drawer.
		if len(thoughts) == 0 || !strings.Contains(thoughts[0], "provide the output") {
			t.Errorf("thoughts = %v, want the dead-end prose moved to thinking", thoughts)
		}
	})

	t.Run("awaiting then real tool call: guard recovers", func(t *testing.T) {
		st, err := newStore(filepath.Join(t.TempDir(), "test.db"))
		if err != nil {
			t.Fatalf("newStore: %v", err)
		}
		defer st.close()
		srv := &server{cfg: config{contextLength: 8192, maxAgentSteps: 6}, store: st}

		mb := &fakeBackend{responses: []oaiMessage{
			narrationMsg("Please provide the output from the tool response so I can proceed."), // round 1: re-prompt
			toolCallMsg("call_1", "get_time", "{}"),                                            // round 2: real tool call
			finalAnswerMsg("Done — updated the settings menu."),                                // round 3: synthesized
		}}

		var (
			steps     []agentStep
			questions []clarifyMeta
		)
		err = srv.runAgentLoop(context.Background(), mb, "test-model", email, msgs, []string{"get_time"}, "",
			func(string) {}, func(string) {},
			func(st agentStep) { steps = append(steps, st) },
			func(c clarifyMeta) { questions = append(questions, c) },
			func(string) {}, func() {}, func(int, int) {}, "", nil, nil, nil, 0)
		if err != nil {
			t.Fatalf("runAgentLoop: %v", err)
		}
		if got := mb.callCount(); got != 3 {
			t.Fatalf("model calls = %d, want 3 (re-prompt -> tool call -> answer)", got)
		}
		// No proceed card — the re-prompt recovered the model into a real call.
		if len(questions) != 0 {
			t.Errorf("questions = %+v, want none (the re-prompt recovered a real tool call)", questions)
		}
		var ranTool *agentStep
		for i := range steps {
			if steps[i].Tool == "get_time" {
				ranTool = &steps[i]
			}
		}
		if ranTool == nil {
			t.Fatalf("no get_time step; steps = %+v", steps)
		}
	})

	t.Run("detector table", func(t *testing.T) {
		cases := []struct {
			text string
			want bool
		}{
			{"Please provide the output from the tool response so I can proceed.", true},
			{"Please paste the result of the grep.", true},
			{"Can you run go test for me?", true},
			{"I need the output of the search to continue.", true},
			{"Could you share the output of the previous command?", true},
			{"The file foo.go already has a comment.", false},
			{"The get_time tool returned 3pm.", false},
			{"Done — added the comment.", false},
			{"", false},
		}
		for _, c := range cases {
			if got := looksLikeAwaitingToolResult(c.text); got != c.want {
				t.Errorf("looksLikeAwaitingToolResult(%q) = %v, want %v", c.text, got, c.want)
			}
		}
	})
}

// TestJob_EmitToolStartAndCommandFields covers the Warp-style command-block
// contract: emitToolStart stashes the pending cue (so a reconnect reopens the
// running block) and broadcasts a toolStart event carrying the frozen payload
// {convId, jobId, step, tool, args}; emitToolExec fires toolStart BEFORE the
// relay cue so the block exists before streamed output lands; emitTool clears
// the stash once the result step lands; and the tool event marshals the command
// fields (ExitCode/Output/Cwd/Branch) so a reload re-paints the block body.
func TestJob_EmitToolStartAndCommandFields(t *testing.T) {
	j := newJob("conv-ts", "user@example.com", "local:1b", false, false, true)
	ch, _ := j.subscribe()
	defer j.unsubscribe(ch)

	// emitToolExec fires toolStart first, then the relay cue.
	j.emitToolExec(2, "run_command", `{"command":"go test ./..."}`, "owner/repo", "main", "", true, 0)

	first := nextEvent(t, ch, time.Second)
	if first.kind != "toolStart" {
		t.Fatalf("first event kind = %q, want toolStart (block must open before the relay cue)", first.kind)
	}
	var ts toolStartPayload
	if err := json.Unmarshal([]byte(first.text), &ts); err != nil {
		t.Fatalf("unmarshal toolStart: %v", err)
	}
	if ts.ConvID != j.convID || ts.JobID != j.id || ts.Step != 2 || ts.Tool != "run_command" || ts.Args != `{"command":"go test ./..."}` {
		t.Errorf("toolStart payload = %+v, want {convId:%q jobId:%q step:2 tool:run_command args:{...}}", ts, j.convID, j.id)
	}
	second := nextEvent(t, ch, time.Second)
	if second.kind != "toolExec" {
		t.Fatalf("second event kind = %q, want toolExec", second.kind)
	}

	// Both cues are stashed for SSE replay on reconnect.
	if got := j.toolStartSnapshot(); got == nil || got.Step != 2 {
		t.Errorf("pendingToolStart should be stashed after emitToolExec, got %+v", got)
	}
	if got := j.toolExecSnapshot(); got == nil || got.Step != 2 {
		t.Errorf("pendingToolExecPayload should be stashed after emitToolExec, got %+v", got)
	}

	// emitTool (the result step) clears the stashed toolStart and carries the
	// command fields on the tool event for reload parity.
	j.emitTool(agentStep{Step: 2, Tool: "run_command", Preview: "command completed", DurationMs: 12, ExitCode: 0, Output: "ok\n", Cwd: "/repo", Branch: "main"})
	if got := j.toolStartSnapshot(); got != nil {
		t.Errorf("pendingToolStart should be cleared after emitTool, got %+v", got)
	}
	ev := nextEvent(t, ch, time.Second)
	if ev.kind != "tool" {
		t.Fatalf("third event kind = %q, want tool", ev.kind)
	}
	var step agentStep
	if err := json.Unmarshal([]byte(ev.text), &step); err != nil {
		t.Fatalf("unmarshal tool: %v", err)
	}
	if step.ExitCode != 0 || step.Output != "ok\n" || step.Cwd != "/repo" || step.Branch != "main" {
		t.Errorf("tool event command fields = {exit:%d output:%q cwd:%q branch:%q}, want all carried", step.ExitCode, step.Output, step.Cwd, step.Branch)
	}
}

// TestJob_EmitToolStartOmitsEmptyCommandFields confirms a read-only tool's
// toolStart/agentStep do not synthesize command fields: a grep call emits a
// toolStart with the contract payload but an agentStep with zero/empty
// ExitCode/Output/Cwd/Branch, so omitempty drops them and old rows stay
// byte-identical on reload.
func TestJob_EmitToolStartOmitsEmptyCommandFields(t *testing.T) {
	j := newJob("conv-ro", "user@example.com", "local:1b", false, false, true)
	ch, _ := j.subscribe()
	defer j.unsubscribe(ch)

	j.emitToolExec(1, "grep", `{"pattern":"foo"}`, "owner/repo", "main", "", true, 0)
	ev := nextEvent(t, ch, time.Second)
	if ev.kind != "toolStart" {
		t.Fatalf("event kind = %q, want toolStart", ev.kind)
	}
	// Drain the toolExec cue so it does not block later reads.
	if ev := nextEvent(t, ch, time.Second); ev.kind != "toolExec" {
		t.Fatalf("expected toolExec after toolStart, got %q", ev.kind)
	}

	j.emitTool(agentStep{Step: 1, Tool: "grep", Preview: "2 matches", DurationMs: 3})
	if got := j.toolStartSnapshot(); got != nil {
		t.Errorf("pendingToolStart should be cleared after emitTool, got %+v", got)
	}
	ev = nextEvent(t, ch, time.Second)
	if ev.kind != "tool" {
		t.Fatalf("event kind = %q, want tool", ev.kind)
	}
	// A read-only tool's tool event must not carry command fields.
	if strings.Contains(ev.text, "exitCode") || strings.Contains(ev.text, "\"output\"") || strings.Contains(ev.text, "\"cwd\"") || strings.Contains(ev.text, "\"branch\"") {
		t.Errorf("read-only tool event should omit command fields, got %s", ev.text)
	}
}

// TestStripProseToolCallText confirms the raw JSON tool-call blob a small model
// wrote as prose is stripped from the thinking text (along with its fenced
// code-block wrapper), so the thinking drawer shows the model's reasoning
// preamble, not the {"name":"...","arguments":{...}} syntax that
// extractProseToolCall recovers into a real tool call.
func TestStripProseToolCallText(t *testing.T) {
	offred := map[string]bool{"run_command": true, "get_time": true}
	cases := []struct {
		name string
		text string
		want string
	}{
		{
			name: "fenced blob with preamble",
			text: "I'll create the file.\n```\n{ \"name\": \"run_command\", \"arguments\": {\"command\": \"echo hi\"} }\n```\nDone.",
			want: "I'll create the file.\n\nDone.",
		},
		{
			name: "raw blob no fence",
			text: "Let me check {\"name\":\"get_time\",\"arguments\":{}} now",
			want: "Let me check  now",
		},
		{
			name: "duplicated blob both stripped",
			text: "{\"name\":\"run_command\",\"arguments\":{\"command\":\"ls\"}}\n{\"name\":\"run_command\",\"arguments\":{\"command\":\"ls\"}}",
			want: "",
		},
		{
			name: "non-tool JSON left alone",
			text: "The config is {\"key\":\"value\"} and that's fine",
			want: "The config is {\"key\":\"value\"} and that's fine",
		},
		{
			name: "fenced with language tag",
			text: "```json\n{\"name\":\"get_time\",\"arguments\":{}}\n```",
			want: "",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := stripProseToolCallText(c.text, offred)
			if got != c.want {
				t.Errorf("stripProseToolCallText = %q, want %q", got, c.want)
			}
		})
	}
}

// TestAgentBudgetWarning80Percent verifies the 80%-of-budget warning: with a
// budget of 5, the loop appends a "Budget notice" system message before the
// model call that crosses 80% (step 4), and not before. The notice tells the
// model how many steps remain so it finishes outstanding edits before the cliff.
func TestAgentBudgetWarning80Percent(t *testing.T) {
	const email = "user@example.com"
	msgs := []oaiMessage{{Role: "user", Content: jsonString("keep checking the time")}}
	st, err := newStore(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("newStore: %v", err)
	}
	defer st.close()
	srv := &server{cfg: config{contextLength: 8192, maxAgentSteps: 5}, store: st}

	// Five tool-call rounds (each crosses one step) then the budget forces a
	// final answer. 80% of 5 is 4, so the warning is injected before the 5th
	// model call (recorded[4]) and absent before the 4th (recorded[3]).
	script := []oaiMessage{
		toolCallMsg("c1", "get_time", "{}"),
		toolCallMsg("c2", "get_time", "{}"),
		toolCallMsg("c3", "get_time", "{}"),
		toolCallMsg("c4", "get_time", "{}"),
		toolCallMsg("c5", "get_time", "{}"),
		finalAnswerMsg("done"),
	}
	mb := &fakeBackend{responses: script}
	var steps []agentStep
	err = srv.runAgentLoop(context.Background(), mb, "test-model", email, msgs, []string{"get_time"}, "",
		func(string) {}, func(string) {}, func(st agentStep) { steps = append(steps, st) },
		func(clarifyMeta) {}, func(string) {}, func() {}, func(int, int) {}, "", nil, nil, nil, 0)
	if err != nil {
		t.Fatalf("runAgentLoop: %v", err)
	}
	if got := mb.callCount(); got != len(script) {
		t.Fatalf("model calls = %d, want %d", got, len(script))
	}
	if len(mb.recorded) <= 4 {
		t.Fatalf("not enough recorded rounds: %d", len(mb.recorded))
	}
	sawNotice := false
	for _, m := range mb.recorded[3] {
		if m.Role == "system" && strings.Contains(contentText(m.Content), "Budget notice") {
			sawNotice = true
		}
	}
	if sawNotice {
		t.Errorf("budget warning fired before 80%% (recorded[3]); should fire at step 4")
	}
	var saw bool
	for _, m := range mb.recorded[4] {
		if m.Role == "system" && strings.Contains(contentText(m.Content), "Budget notice") && strings.Contains(contentText(m.Content), "1 tool-call step(s) remain") {
			saw = true
		}
	}
	if !saw {
		t.Errorf("budget warning missing from the 80%% crossing call (recorded[4]): %v", mb.recorded[4])
	}
	// A (budget) trace step must be emitted when the budget forces the final answer.
	var budgetStep *agentStep
	for i := range steps {
		if steps[i].Tool == "(budget)" {
			budgetStep = &steps[i]
		}
	}
	if budgetStep == nil {
		t.Errorf("no (budget) trace step emitted; steps = %+v", steps)
	}
}

// TestAgentNarrationRetryDoesNotConsumeStep verifies that a narration re-prompt
// round does not consume a step of the budget. With a budget of 1, the model
// narrates on round 1 then emits a real tool call on round 2. Under the old
// for-step counter the narration would burn the only step, the loop would exit
// before the tool ever ran, and the model would be forced to a final answer.
// Now the narration's continue skips the step increment, so the tool call still
// runs within the budget and the forced answer only fires after it.
func TestAgentNarrationRetryDoesNotConsumeStep(t *testing.T) {
	const email = "user@example.com"
	msgs := []oaiMessage{{Role: "user", Content: jsonString("Add a comment to foo.go")}}
	st, err := newStore(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("newStore: %v", err)
	}
	defer st.close()
	srv := &server{cfg: config{contextLength: 8192, maxAgentSteps: 1}, store: st}

	mb := &fakeBackend{responses: []oaiMessage{
		narrationMsg("I'll edit foo.go to add a comment."), // round 1: narrates (no step charged)
		toolCallMsg("call_1", "get_time", "{}"),            // round 2: real tool call (step 0 -> 1)
		finalAnswerMsg("Done — added the comment."),        // forced answer after the budget exit
	}}
	var steps []agentStep
	err = srv.runAgentLoop(context.Background(), mb, "test-model", email, msgs, []string{"get_time"}, "",
		func(string) {}, func(string) {}, func(st agentStep) { steps = append(steps, st) },
		func(clarifyMeta) {}, func(string) {}, func() {}, func(int, int) {}, "", nil, nil, nil, 0)
	if err != nil {
		t.Fatalf("runAgentLoop: %v", err)
	}
	// 3 calls: narration, tool call, forced answer. Under the old code this
	// would be 2 (narration consumed the only step, tool never ran).
	if got := mb.callCount(); got != 3 {
		t.Fatalf("model calls = %d, want 3 (narration did not consume the budget)", got)
	}
	var ranTool *agentStep
	for i := range steps {
		if steps[i].Tool == "get_time" {
			ranTool = &steps[i]
		}
	}
	if ranTool == nil {
		t.Fatalf("no get_time step; the narration must not have consumed the only step. steps = %+v", steps)
	}
}

// TestLocalRepoToolsContainsGitLogAndListPrs guards the dedupe: git_log and
// list_prs already had sidecar executors but were missing from every backend
// list, so the model could never call them. localRepoTools() is now the single
// source of truth shared by defaultAgentTools, availableTools, and the repo-bound
// allow append — so all three surfaces must include them.
func TestLocalRepoToolsContainsGitLogAndListPrs(t *testing.T) {
	if !slicesContains(localRepoTools(), "git_log") {
		t.Errorf("localRepoTools() does not include git_log")
	}
	if !slicesContains(localRepoTools(), "list_prs") {
		t.Errorf("localRepoTools() does not include list_prs")
	}
	if !slicesContains(defaultAgentTools(), "git_log") || !slicesContains(defaultAgentTools(), "list_prs") {
		t.Errorf("defaultAgentTools() does not include git_log/list_prs")
	}
	seen := map[string]bool{}
	for _, tm := range availableTools(false, nil) {
		seen[tm.Name] = true
	}
	if !seen["git_log"] || !seen["list_prs"] {
		t.Errorf("availableTools(false, nil) does not include git_log/list_prs")
	}
	st, err := newStore(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("newStore: %v", err)
	}
	defer st.close()
	srv := &server{cfg: config{contextLength: 8192}, store: st}
	reg := srv.toolRegistry("")
	for _, name := range []string{"git_log", "list_prs"} {
		tool, ok := reg[name]
		if !ok {
			t.Errorf("toolRegistry does not register %s", name)
			continue
		}
		if !tool.local {
			t.Errorf("%s must be a local (sidecar-relayed) tool, got local=false", name)
		}
	}
}

// TestAgentPauseReturnsCheckpoint verifies the pause path: when pauseRequested
// turns true after a round's tools complete, runAgentLoop returns
// errAgentPaused carrying the transcript and the step index (the number of
// completed rounds), so the worker can write a checkpoint and a later resume
// can rehydrate the conversation and continue on the remaining budget. No tool
// relay is left in flight because the check fires between steps.
func TestAgentPauseReturnsCheckpoint(t *testing.T) {
	const email = "user@example.com"
	msgs := []oaiMessage{{Role: "user", Content: jsonString("Add a comment to foo.go")}}
	st, err := newStore(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("newStore: %v", err)
	}
	defer st.close()
	srv := &server{cfg: config{contextLength: 8192, maxAgentSteps: 10}, store: st}

	mb := &fakeBackend{responses: []oaiMessage{
		toolCallMsg("c1", "get_time", "{}"), // round 1 runs
		toolCallMsg("c2", "get_time", "{}"), // would be round 2 (never reached)
		finalAnswerMsg("done"),
	}}
	checks := 0
	pauseRequested := func() bool {
		checks++
		// false for the top-of-loop check (checks=1); true on the after-tools
		// check (checks=2) so the pause is detected once round 1 completes.
		return checks > 1
	}
	err = srv.runAgentLoop(context.Background(), mb, "test-model", email, msgs, []string{"get_time"}, "",
		func(string) {}, func(string) {}, func(st agentStep) {},
		func(clarifyMeta) {}, func(string) {}, func() {}, func(int, int) {},
		"", nil, pauseRequested, nil, 0)
	if !errors.Is(err, errAgentPaused) {
		t.Fatalf("err = %v, want errAgentPaused", err)
	}
	pe, ok := err.(*pausedError)
	if !ok {
		t.Fatalf("err is not *pausedError: %T", err)
	}
	// One round completed (step 0 -> 1), so the checkpoint step is 1; a
	// resumed run starting at step 1 continues on the remaining budget.
	if pe.step != 1 {
		t.Errorf("paused step = %d, want 1", pe.step)
	}
	if mb.callCount() != 1 {
		t.Errorf("model calls = %d, want 1 (only the pre-pause round ran)", mb.callCount())
	}
	if len(pe.transcript) < 4 {
		t.Errorf("paused transcript has %d messages, want at least 4 (system + user + assistant + tool result)", len(pe.transcript))
	}
	last := pe.transcript[len(pe.transcript)-1]
	if last.Role != "tool" || !strings.Contains(contentText(last.Content), "Current date") {
		t.Errorf("last transcript message = %+v, want the get_time tool result", last)
	}
}

// TestCheckpointRoundTrip exercises save/load/delete on agent_checkpoints,
// including the upsert (a second pause overwrites the first) and that the
// transcript (an []oaiMessage) round-trips through JSON.
func TestCheckpointRoundTrip(t *testing.T) {
	st, err := newStore(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("newStore: %v", err)
	}
	defer st.close()
	const email = "user@example.com"
	convID := "conv-cp"
	cp := agentCheckpoint{
		JobID: "job1", ConvID: convID, Email: email, Step: 3,
		Transcript: []oaiMessage{{Role: "system", Content: jsonString("sys")}, {Role: "user", Content: jsonString("hi")}},
		Model:      "test-model", Local: true, SupportsTools: true, CreatedAt: 12345,
	}
	if err := st.saveCheckpoint(cp); err != nil {
		t.Fatalf("saveCheckpoint: %v", err)
	}
	loaded, err := st.loadCheckpoint(email, convID)
	if err != nil || loaded == nil {
		t.Fatalf("loadCheckpoint: err=%v loaded=%v", err, loaded)
	}
	if loaded.Step != 3 || loaded.Model != "test-model" || !loaded.Local || !loaded.SupportsTools {
		t.Errorf("loaded = %+v, want step 3 / model test-model / local / supportsTools", loaded)
	}
	if len(loaded.Transcript) != 2 || contentText(loaded.Transcript[1].Content) != "hi" {
		t.Errorf("loaded transcript = %+v, want 2 messages with hi", loaded.Transcript)
	}
	// A second save upserts over the first (a re-pause replaces the checkpoint).
	cp2 := cp
	cp2.Step = 5
	if err := st.saveCheckpoint(cp2); err != nil {
		t.Fatalf("saveCheckpoint2: %v", err)
	}
	loaded2, _ := st.loadCheckpoint(email, convID)
	if loaded2 == nil || loaded2.Step != 5 {
		t.Errorf("upserted checkpoint step = %v, want 5", loaded2)
	}
	if err := st.deleteCheckpoint(email, convID); err != nil {
		t.Fatalf("deleteCheckpoint: %v", err)
	}
	gone, _ := st.loadCheckpoint(email, convID)
	if gone != nil {
		t.Errorf("checkpoint still present after delete")
	}
}

// TestReconcileJobsLeavesPausedAlone guards restart-safety: reconcileJobs only
// errors queued/generating jobs, so a paused job (whose in-memory state died
// with the process) is still resumable from its checkpoint after a backend
// restart.
func TestReconcileJobsLeavesPausedAlone(t *testing.T) {
	st, err := newStore(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("newStore: %v", err)
	}
	defer st.close()
	const email = "user@example.com"
	now := time.Now().UnixMilli()
	// Insert a paused job (should survive reconcile) and a generating job (should
	// be errored by reconcile) after newStore's initial reconcile ran.
	_, err = st.db.Exec(`INSERT INTO jobs(id, conversation_id, email, status, model, created_at) VALUES(?, ?, ?, 'paused', ?, ?)`, "j-pause", "c1", email, "m", now)
	if err != nil {
		t.Fatalf("insert paused: %v", err)
	}
	_, err = st.db.Exec(`INSERT INTO jobs(id, conversation_id, email, status, model, created_at) VALUES(?, ?, ?, 'generating', ?, ?)`, "j-gen", "c2", email, "m", now)
	if err != nil {
		t.Fatalf("insert generating: %v", err)
	}
	if err := reconcileJobs(st.db); err != nil {
		t.Fatalf("reconcileJobs: %v", err)
	}
	var pausedStatus, genStatus string
	_ = st.db.QueryRow(`SELECT status FROM jobs WHERE id = ?`, "j-pause").Scan(&pausedStatus)
	_ = st.db.QueryRow(`SELECT status FROM jobs WHERE id = ?`, "j-gen").Scan(&genStatus)
	if pausedStatus != "paused" {
		t.Errorf("paused job status = %q, want paused — reconcile must not touch it", pausedStatus)
	}
	if genStatus != "error" {
		t.Errorf("generating job status = %q, want error", genStatus)
	}
}

// TestInjectRepoContext verifies the repo-context system-prompt block is
// worktree- and secret-aware: a branch-bound (worktree) run names the bound
// branch, states gitignored files like .env are absent by design and must never
// be read, and lists tree among the exploration tools; a branchless run uses
// the repo's main working tree. Guards the primary remedy for the "agent can't
// find .env" confusion — .env is gitignored, so it is not materialized in a
// fresh per-branch worktree, and the prompt now says so instead of leaving the
// model to flail.
func TestInjectRepoContext(t *testing.T) {
	repo := &Repo{
		FullName: "owner/repo",
		Branch:   "main",
		Head:     "0123456789abcdef0123456789abcdef01234567",
		Tree:     []string{"backend/", "www/", ".gitignore"},
	}
	const sys = "BASE PROMPT"

	gotWorktree := injectRepoContext(sys, repo, "agent/foo-123")
	if !strings.Contains(gotWorktree, "owner/repo") {
		t.Errorf("worktree prompt missing repo name: %q", gotWorktree)
	}
	if !strings.Contains(gotWorktree, "agent/foo-123") {
		t.Errorf("worktree prompt missing bound branch: %q", gotWorktree)
	}
	if !strings.Contains(gotWorktree, "isolated per-branch git worktree") {
		t.Errorf("worktree prompt missing worktree notice: %q", gotWorktree)
	}
	if !strings.Contains(gotWorktree, ".env") || !strings.Contains(gotWorktree, "secret") {
		t.Errorf("worktree prompt missing .env/secret guidance: %q", gotWorktree)
	}
	if !strings.Contains(gotWorktree, "tree") {
		t.Errorf("worktree prompt missing tree tool: %q", gotWorktree)
	}
	if !strings.Contains(gotWorktree, sys) {
		t.Errorf("worktree prompt did not append base system prompt: %q", gotWorktree)
	}

	// Branchless: uses the repo's main working tree, still secret-aware, and
	// must NOT claim an isolated worktree.
	gotMain := injectRepoContext(sys, repo, "")
	if !strings.Contains(gotMain, "main working tree") {
		t.Errorf("branchless prompt missing main-tree notice: %q", gotMain)
	}
	if !strings.Contains(gotMain, ".env") || !strings.Contains(gotMain, "secret") {
		t.Errorf("branchless prompt missing .env/secret guidance: %q", gotMain)
	}
	if strings.Contains(gotMain, "isolated per-branch git worktree") {
		t.Errorf("branchless prompt wrongly claims a worktree: %q", gotMain)
	}
}

// TestParseProseToolCallBlob covers the prose tool-call parser's key-alias
// support: a small model that can't emit structured tool_calls deltas often
// writes the call as a JSON blob in prose, and different chat templates spell
// the keys differently. The parser must recognize name/arguments (OpenAI),
// tool/input (Anthropic-style), function/parameters, and the nested OpenAI
// tool_calls shape — and leave a non-tool JSON object alone so it is not
// mistaken for a call.
func TestParseProseToolCallBlob(t *testing.T) {
	offered := map[string]bool{"run_command": true, "get_time": true}
	cases := []struct {
		name     string
		blob     string
		wantName string
		wantArgs string
		wantOk   bool
	}{
		{
			name: "openai name/arguments object", blob: `{"name":"run_command","arguments":{"command":"ls"}}`,
			wantName: "run_command", wantArgs: `{"command":"ls"}`, wantOk: true,
		},
		{
			name: "anthropic tool/input", blob: `{"tool":"run_command","input":{"command":"ls"}}`,
			wantName: "run_command", wantArgs: `{"command":"ls"}`, wantOk: true,
		},
		{
			name: "function/parameters string alias", blob: `{"function":"run_command","parameters":{"command":"ls"}}`,
			wantName: "run_command", wantArgs: `{"command":"ls"}`, wantOk: true,
		},
		{
			name: "nested openai tool_calls shape with string arguments", blob: `{"id":"x","type":"function","function":{"name":"get_time","arguments":"{}"}}`,
			wantName: "get_time", wantArgs: `{}`, wantOk: true,
		},
		{
			name: "nested openai tool_calls shape with object arguments", blob: `{"type":"function","function":{"name":"run_command","arguments":{"command":"go test"}}}`,
			wantName: "run_command", wantArgs: `{"command":"go test"}`, wantOk: true,
		},
		{
			name: "missing arguments defaults to empty object", blob: `{"name":"get_time"}`,
			wantName: "get_time", wantArgs: `{}`, wantOk: true,
		},
		{
			name: "non-tool JSON left alone", blob: `{"key":"value"}`, wantOk: false,
		},
		{
			name: "name not in offered set", blob: `{"name":"unknown_tool","arguments":{}}`, wantOk: false,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			gotName, gotArgs, gotOk := parseProseToolCallBlob(c.blob, offered)
			if gotOk != c.wantOk {
				t.Fatalf("ok = %v, want %v (name=%q args=%q)", gotOk, c.wantOk, gotName, gotArgs)
			}
			if !c.wantOk {
				return
			}
			if gotName != c.wantName {
				t.Errorf("name = %q, want %q", gotName, c.wantName)
			}
			if gotArgs != c.wantArgs {
				t.Errorf("args = %q, want %q", gotArgs, c.wantArgs)
			}
		})
	}
}

// TestAgentProseToolCallRecoveryAliasedKeys verifies the parser recovers a tool
// call written with Anthropic-style tool/input keys (not just OpenAI
// name/arguments), runs it, and — because prose-recovery succeeded — the run
// does NOT emit the (format) "never emitted a structured tool call" diagnostic.
// The parser bridging the model's prose call into a real execution means Agent
// mode is functional, so the broken-template hint is suppressed.
func TestAgentProseToolCallRecoveryAliasedKeys(t *testing.T) {
	const email = "user@example.com"
	msgs := []oaiMessage{{Role: "user", Content: jsonString("What time is it?")}}
	st, err := newStore(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("newStore: %v", err)
	}
	defer st.close()
	srv := &server{cfg: config{contextLength: 8192, maxAgentSteps: 6}, store: st}

	narrated := "Let me check the time.\n```json\n{\"tool\": \"get_time\", \"input\": {}}\n```"
	mb := &fakeBackend{responses: []oaiMessage{
		narrationMsg(narrated),      // round 1: narrates the call as tool/input JSON prose
		finalAnswerMsg("It's 3pm."), // round 2: synthesizes after the real observation
	}}
	var steps []agentStep
	err = srv.runAgentLoop(context.Background(), mb, "test-model", email, msgs, []string{"get_time"}, "",
		func(string) {}, func(string) {}, func(st agentStep) { steps = append(steps, st) },
		func(clarifyMeta) {}, func(string) {}, func() {}, func(int, int) {}, "", nil, nil, nil, 0)
	if err != nil {
		t.Fatalf("runAgentLoop: %v", err)
	}
	if got := mb.callCount(); got != 2 {
		t.Fatalf("model calls = %d, want 2 (recovered call ran, then synthesized)", got)
	}
	var ranTool *agentStep
	for i := range steps {
		if steps[i].Tool == "get_time" {
			ranTool = &steps[i]
		}
	}
	if ranTool == nil {
		t.Fatalf("no get_time step; the tool/input prose call should have been recovered. steps = %+v", steps)
	}
	if ranTool.IsError {
		t.Errorf("recovered get_time step errored: %+v", ranTool)
	}
	for _, st := range steps {
		if st.Tool == "(format)" {
			t.Errorf("(format) diagnostic emitted despite successful prose recovery: %+v", st)
		}
	}
}

// TestAgentFormatHintFiresOnNarrationOnly verifies the (format) diagnostic still
// surfaces the genuine dead-end: a model that only narrates intentions and never
// produces a usable (structured or prose-recoverable) tool call. This is the
// case the hint is meant for — a mislabeled tool-capable model or a broken chat
// template — so it must not be suppressed by the prose-recovery carve-out.
func TestAgentFormatHintFiresOnNarrationOnly(t *testing.T) {
	const email = "user@example.com"
	msgs := []oaiMessage{{Role: "user", Content: jsonString("Add a comment to foo.go")}}
	st, err := newStore(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("newStore: %v", err)
	}
	defer st.close()
	srv := &server{cfg: config{contextLength: 8192, maxAgentSteps: 6}, store: st}

	mb := &fakeBackend{responses: []oaiMessage{
		narrationMsg("I'll edit foo.go to add a comment."), // round 1: no JSON -> re-prompt
		narrationMsg("I'll change bar.go too."),            // round 2: exhausted -> accept
	}}
	var steps []agentStep
	err = srv.runAgentLoop(context.Background(), mb, "test-model", email, msgs, []string{"get_time"}, "",
		func(string) {}, func(string) {}, func(st agentStep) { steps = append(steps, st) },
		func(clarifyMeta) {}, func(string) {}, func() {}, func(int, int) {}, "", nil, nil, nil, 0)
	if err != nil {
		t.Fatalf("runAgentLoop: %v", err)
	}
	var format *agentStep
	for i := range steps {
		if steps[i].Tool == "(format)" {
			format = &steps[i]
		}
	}
	if format == nil {
		t.Errorf("no (format) diagnostic emitted; a narration-only run with no recovery should surface it. steps = %+v", steps)
	}
}

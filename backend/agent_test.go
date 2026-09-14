package main

import (
	"context"
	"encoding/json"
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
				if _, err := st.patchConversation(email, convID, nil, nil, nil, &sys, nil, nil, nil, nil); err != nil {
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
// scope: the configurable system prompt is an agent-harness concern. A plain
// (non-agent) turn must NOT carry a system message even when a global
// agent_system setting exists — plain chat runs a bare streamed pass with no
// prepended system prompt. This keeps the harness boundary explicit so a later
// change that widens injection is intentional.
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

	// A plain turn's messages are exactly the conversation turns — no system
	// prefix at all, and never the agent_system setting.
	for i, m := range mc.Messages {
		if m.Role == "system" {
			t.Errorf("plain turn messages[%d] is role %q with content %q; plain chat must not inject a system prompt",
				i, m.Role, contentText(m.Content))
		}
		if strings.Contains(contentText(m.Content), "SECRET AGENT PROMPT") {
			t.Errorf("plain turn leaked the agent_system setting at messages[%d]: %q", i, contentText(m.Content))
		}
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
// any live Ollama. calls counts how many rounds were actually run.
type fakeBackend struct {
	mu        sync.Mutex
	responses []oaiMessage
	calls     int
}

func (f *fakeBackend) Call(ctx context.Context, model string, messages []oaiMessage, tools []oaiTool) (oaiMessage, agentUsage, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
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
			toolCallMsg("call_1", "get_time", "{}"),           // round 2: real tool call
			finalAnswerMsg("Done - added the comment."),      // round 3: synthesized answer
		}}

		var (
			steps    []agentStep
			thoughts []string
			phases   []string
		)
		err = srv.runAgentLoop(context.Background(), mb, "test-model", email, msgs, []string{"get_time"}, "",
			func(string) {}, func(p string) { phases = append(phases, p) },
			func(st agentStep) { steps = append(steps, st) }, func(clarifyMeta) {},
			func(s string) { thoughts = append(thoughts, s) }, func() {}, func(int, int) {}, "", nil)
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
			narrationMsg("I'll change bar.go too."),          // round 2: budget exhausted -> accept
		}}

		var steps []agentStep
		err = srv.runAgentLoop(context.Background(), mb, "test-model", email, msgs, []string{"get_time"}, "",
			func(string) {}, func(string) {}, func(st agentStep) { steps = append(steps, st) },
			func(clarifyMeta) {}, func(string) {}, func() {}, func(int, int) {}, "", nil)
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
			func(clarifyMeta) {}, func(s string) { thoughts = append(thoughts, s) }, func() {}, func(int, int) {}, "", nil)
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
			narrationMsg(narrated),                  // round 1: narrates the call as JSON prose
			finalAnswerMsg("It's 3pm."),             // round 2: synthesizes after the real observation
		}}

		var (
			steps    []agentStep
			thoughts []string
		)
		err = srv.runAgentLoop(context.Background(), mb, "test-model", email, msgs, []string{"get_time"}, "",
			func(string) {}, func(string) {}, func(st agentStep) { steps = append(steps, st) },
			func(clarifyMeta) {}, func(s string) { thoughts = append(thoughts, s) }, func() {}, func(int, int) {}, "", nil)
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
			narrationMsg("I'll check it now."),          // round 2: budget exhausted -> accept
		}}

		var steps []agentStep
		err = srv.runAgentLoop(context.Background(), mb, "test-model", email, msgs, []string{"get_time"}, "",
			func(string) {}, func(string) {}, func(st agentStep) { steps = append(steps, st) },
			func(clarifyMeta) {}, func(string) {}, func() {}, func(int, int) {}, "", nil)
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
			"", nil)
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
			toolCallMsg("call_1", "get_time", "{}"),                                              // round 2: real tool call
			finalAnswerMsg("Done — updated the settings menu."),                                  // round 3: synthesized
		}}

		var (
			steps     []agentStep
			questions []clarifyMeta
		)
		err = srv.runAgentLoop(context.Background(), mb, "test-model", email, msgs, []string{"get_time"}, "",
			func(string) {}, func(string) {},
			func(st agentStep) { steps = append(steps, st) },
			func(c clarifyMeta) { questions = append(questions, c) },
			func(string) {}, func() {}, func(int, int) {}, "", nil)
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

package main

import (
	"encoding/json"
	"path/filepath"
	"strings"
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
		want      string // expected system message content
		exact     bool   // true = want must equal the content; false = want is a substring
	}{
		{
			name:      "per-conversation override wins over global and default",
			convSys:   "You are a test agent. Always reply with PONG.",
			globalSys: "You are a global agent. Be terse.",
			want:      "You are a test agent. Always reply with PONG.",
			exact:     true,
		},
		{
			name:      "global setting wins when no per-conversation override",
			globalSys: "You are a global test agent. Be terse.",
			want:      "You are a global test agent. Be terse.",
			exact:     true,
		},
		{
			name:  "built-in default nudge when nothing configured",
			want:  "You are a capable agent running on a small local server.",
			exact: false,
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
				if _, err := st.patchConversation(email, convID, nil, nil, nil, &sys, nil); err != nil {
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
			if c.exact {
				if got != c.want {
					t.Errorf("system prompt = %q, want exactly %q", got, c.want)
				}
			} else if !strings.Contains(got, c.want) {
				t.Errorf("system prompt = %q, want it to contain %q", got, c.want)
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

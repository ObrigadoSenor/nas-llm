package main

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestDetectClarifyFromContent(t *testing.T) {
	cases := []struct {
		name    string
		content string
		want    *clarifyMeta
	}{
		{
			name:    "example parenthetical",
			content: "Question: What is your primary use case for running the LLMs? (e.g., Chatbot development, coding assistance, writing, general curiosity). Knowing this will make the plan much more precise.",
			want: &clarifyMeta{Questions: []clarifyQuestion{{Text: "What is your primary use case for running the LLMs?", Type: "single", Options: []clarifyOption{
				{Label: "Chatbot development", Value: "Chatbot development"},
				{Label: "coding assistance", Value: "coding assistance"},
				{Label: "writing", Value: "writing"},
				{Label: "general curiosity", Value: "general curiosity"},
			}}}},
		},
		{
			name:    "numbered list",
			content: "Which language do you prefer?\n1. Python\n2. Go\n3. Rust",
			want: &clarifyMeta{Questions: []clarifyQuestion{{Text: "Which language do you prefer?", Type: "single", Options: []clarifyOption{
				{Label: "Python", Value: "Python"},
				{Label: "Go", Value: "Go"},
				{Label: "Rust", Value: "Rust"},
			}}}},
		},
		{name: "normal answer", content: "The capital of France is Paris. It has been the capital since the 10th century.", want: nil},
		{name: "too long overall", content: strings.Repeat("a", 601) + "? (x, y)", want: nil},
		{name: "question too long", content: strings.Repeat("a", 201) + "? (x, y)", want: nil},
		{name: "free question no options", content: "What would you like to do next?", want: nil},
		{name: "single parenthetical option rejected", content: "Do you want option A? (A).", want: nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := detectClarifyFromContent(c.content)
			if c.want == nil {
				if got != nil {
					t.Fatalf("detectClarifyFromContent = %+v, want nil", got)
				}
				return
			}
			if got == nil {
				t.Fatalf("detectClarifyFromContent = nil, want %+v", c.want)
			}
			if len(got.Questions) != len(c.want.Questions) {
				t.Fatalf("questions = %d, want %d", len(got.Questions), len(c.want.Questions))
			}
			gq, wq := got.Questions[0], c.want.Questions[0]
			if gq.Text != wq.Text || gq.Type != wq.Type {
				t.Errorf("question = {Text:%q Type:%q}, want {Text:%q Type:%q}", gq.Text, gq.Type, wq.Text, wq.Type)
			}
			if len(gq.Options) != len(wq.Options) {
				t.Fatalf("options = %d, want %d (%+v)", len(gq.Options), len(wq.Options), gq.Options)
			}
			for i, wo := range wq.Options {
				if gq.Options[i] != wo {
					t.Errorf("option[%d] = %+v, want %+v", i, gq.Options[i], wo)
				}
			}
		})
	}
}

// TestRunGeneration_PlainChatOffersAskUser verifies that a tool-capable plain
// chat turn (no Clarify/Agent toggle) now offers the ask_user tool, so a
// clarifying question renders as an interactive card instead of prose. Uses a
// local (browser-relay) job so the backend trusts the frontend supportsTools
// verdict; the relay round is driven by claiming the pending channel with an
// ask_user tool_call, as the browser would POST it.
func TestRunGeneration_PlainChatOffersAskUser(t *testing.T) {
	st, err := newStore(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("newStore: %v", err)
	}
	defer st.close()
	srv := &server{cfg: config{contextLength: 8192, askUserInPlainChat: true, clarifyProseDetect: true}, store: st}
	srv.jobs = newJobManager(st, srv)

	const email = "user@example.com"
	convID := "conv-ask"
	if _, err := st.createConversation(email, convID, "t", "local:1b",
		[]Message{{Role: "user", Content: "help me plan something"}}); err != nil {
		t.Fatalf("createConversation: %v", err)
	}

	j := newJob(convID, email, "local:1b", false, false, false) // plain turn
	j.local = true
	j.supportsTools = true // tool-capable local model (frontend verdict, trusted for local)

	ch, _ := j.subscribe()
	defer j.unsubscribe(ch)
	if err := srv.jobs.enqueue(j); err != nil {
		t.Fatalf("enqueue: %v", err)
	}

	// The plain turn offers ask_user: the modelCall cue carries the ask_user tool.
	waitForRelay(t, j, 5*time.Second)
	var mc modelCallPayload
	sawModelCall := false
	for !sawModelCall {
		ev := nextEvent(t, ch, 5*time.Second)
		if ev.kind == "modelCall" {
			if err := json.Unmarshal([]byte(ev.text), &mc); err != nil {
				t.Fatalf("unmarshal modelCall: %v", err)
			}
			sawModelCall = true
		}
	}
	if len(mc.Tools) != 1 || mc.Tools[0].Function.Name != "ask_user" {
		t.Fatalf("plain tool-capable modelCall should carry one ask_user tool, got %d: %+v", len(mc.Tools), mc.Tools)
	}

	// The browser POSTs an ask_user tool_call → the backend stashes a question card.
	tc := oaiToolCall{ID: "tc1", Type: "function"}
	tc.Function.Name = "ask_user"
	tc.Function.Arguments = `{"questions":[{"text":"What is your primary use case?","type":"single","options":[{"label":"Chatbot development"},{"label":"Coding assistance"},{"label":"Writing"},{"label":"General curiosity"}]}]}`
	claimRelay(t, j, relayResponse{toolCalls: []oaiToolCall{tc}})

	sawQuestions := false
	for !sawQuestions {
		ev := nextEvent(t, ch, 5*time.Second)
		if ev.kind == "questions" {
			sawQuestions = true
			var q clarifyMeta
			if err := json.Unmarshal([]byte(ev.text), &q); err != nil {
				t.Fatalf("unmarshal questions: %v", err)
			}
			if len(q.Questions) != 1 || q.Questions[0].Text != "What is your primary use case?" {
				t.Errorf("questions = %+v, want one question with the ask_user text", q)
			}
			if len(q.Questions[0].Options) != 4 {
				t.Errorf("options = %d, want 4", len(q.Questions[0].Options))
			}
		}
	}
	if !sawQuestions {
		t.Fatalf("expected a questions event after the ask_user tool call")
	}

	select {
	case <-j.finished:
	case <-time.After(5 * time.Second):
		t.Fatalf("job did not finalize after the ask_user turn")
	}
	if got := j.clarifySnapshot(); got == nil {
		t.Errorf("clarifySnapshot = nil, want the stashed question card")
	}
}

// TestRunGeneration_PlainChatNonToolSkipsAskUser verifies the other side: a
// non-tool plain turn skips the ask_user pass (no tool-schema overhead) and
// runs a plain streamed pass, so a normal answer is persisted with no card.
func TestRunGeneration_PlainChatNonToolSkipsAskUser(t *testing.T) {
	st, err := newStore(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("newStore: %v", err)
	}
	defer st.close()
	srv := &server{cfg: config{contextLength: 8192, askUserInPlainChat: true, clarifyProseDetect: true}, store: st}
	srv.jobs = newJobManager(st, srv)

	const email = "user@example.com"
	convID := "conv-notool-plain"
	if _, err := st.createConversation(email, convID, "t", "local:1b",
		[]Message{{Role: "user", Content: "what is 2+2?"}}); err != nil {
		t.Fatalf("createConversation: %v", err)
	}

	j := newJob(convID, email, "local:1b", false, false, false) // plain turn
	j.local = true
	j.supportsTools = false // non-tool local model

	ch, _ := j.subscribe()
	defer j.unsubscribe(ch)
	if err := srv.jobs.enqueue(j); err != nil {
		t.Fatalf("enqueue: %v", err)
	}

	// A non-tool plain turn skips ask_user: the modelCall cue carries no tools.
	waitForRelay(t, j, 5*time.Second)
	var mc modelCallPayload
	sawModelCall := false
	for !sawModelCall {
		ev := nextEvent(t, ch, 5*time.Second)
		if ev.kind == "modelCall" {
			if err := json.Unmarshal([]byte(ev.text), &mc); err != nil {
				t.Fatalf("unmarshal modelCall: %v", err)
			}
			sawModelCall = true
		}
	}
	if len(mc.Tools) != 0 {
		t.Fatalf("non-tool plain modelCall should carry no tools, got %d: %+v", len(mc.Tools), mc.Tools)
	}

	// The browser delivers a normal answer; the job finalizes as a plain done.
	claimRelay(t, j, relayResponse{content: "4"})

	select {
	case <-j.finished:
	case <-time.After(5 * time.Second):
		t.Fatalf("job did not finalize after the plain answer")
	}
	status, content, _ := j.snapshot()
	if status != "done" {
		t.Errorf("job status = %q, want \"done\"", status)
	}
	if content != "4" {
		t.Errorf("content = %q, want \"4\"", content)
	}
	if got := j.clarifySnapshot(); got != nil {
		t.Errorf("clarifySnapshot = %+v, want nil for a plain answer", got)
	}
}

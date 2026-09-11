package main

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// waitForRelay polls the job until browserRelay.Call arms its pending-response
// channel (pendingRelay), or fails the test after a deadline.
func waitForRelay(t *testing.T, j *job, deadline time.Duration) chan relayResponse {
	t.Helper()
	deadlineCh := time.After(deadline)
	for {
		j.mu.Lock()
		ch := j.pendingRelay
		j.mu.Unlock()
		if ch != nil {
			return ch
		}
		select {
		case <-deadlineCh:
			t.Fatalf("browserRelay.Call did not arm pendingRelay in %v", deadline)
		default:
		}
		time.Sleep(time.Millisecond)
	}
}

// claimRelay atomically claims and clears the job's pending-response channel
// (mirroring handleModelResponse's claim) and delivers the response. The
// channel is buffered (cap 1) so the send never blocks whether or not Call has
// reached its receive yet.
func claimRelay(t *testing.T, j *job, resp relayResponse) {
	t.Helper()
	j.mu.Lock()
	ch := j.pendingRelay
	if ch != nil {
		j.pendingRelay = nil
	}
	j.mu.Unlock()
	if ch == nil {
		t.Fatalf("no pending relay channel to claim")
	}
	ch <- resp
}

// TestBrowserRelay_CallReceivesResponse drives the happy path: Call arms the
// pending channel and emits a modelCall, the browser's POST delivers content,
// and Call returns the assembled assistant message with content accumulated on
// the job for persistence (without broadcasting chunks) and the pending
// modelCall cleared.
func TestBrowserRelay_CallReceivesResponse(t *testing.T) {
	j := newJob("conv", "user@example.com", "local:1b", false, false, false)
	mb := &browserRelay{j: j}

	type res struct {
		msg oaiMessage
		err error
	}
	resCh := make(chan res, 1)
	go func() {
		msg, _, err := mb.Call(context.Background(), "local:1b",
			[]oaiMessage{{Role: "user", Content: jsonString("hi")}}, nil)
		resCh <- res{msg, err}
	}()

	waitForRelay(t, j, 2*time.Second)
	claimRelay(t, j, relayResponse{content: "answer"})

	select {
	case r := <-resCh:
		if r.err != nil {
			t.Fatalf("Call returned error: %v", r.err)
		}
		if got := contentText(r.msg.Content); got != "answer" {
			t.Errorf("content = %q, want %q", got, "answer")
		}
		if len(r.msg.ToolCalls) != 0 {
			t.Errorf("expected no tool calls, got %d", len(r.msg.ToolCalls))
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("browserRelay.Call did not return after response")
	}

	// Content was accumulated (without broadcasting) so the worker can persist it.
	if got := j.contentString(); got != "answer" {
		t.Errorf("accumulated content = %q, want %q", got, "answer")
	}
	// The pending modelCall was cleared once the response arrived.
	if mc := j.modelCallSnapshot(); mc != nil {
		t.Errorf("pendingModelCall should be cleared after response, got %+v", mc)
	}
}

// TestBrowserRelay_CallPassesToolCalls confirms a relay round that returns
// tool_calls surfaces them on the assistant message so the loop can continue
// (execute tools server-side, then call the backend again).
func TestBrowserRelay_CallPassesToolCalls(t *testing.T) {
	j := newJob("conv", "user@example.com", "local:1b", false, false, false)
	mb := &browserRelay{j: j}

	type res struct {
		msg oaiMessage
		err error
	}
	resCh := make(chan res, 1)
	go func() {
		msg, _, err := mb.Call(context.Background(), "local:1b",
			[]oaiMessage{{Role: "user", Content: jsonString("search?")}}, []oaiTool{webSearchTool})
		resCh <- res{msg, err}
	}()

	waitForRelay(t, j, 2*time.Second)
	tc := oaiToolCall{ID: "tc1", Type: "function"}
	tc.Function.Name = "web_search"
	tc.Function.Arguments = `{"query":"golang"}`
	claimRelay(t, j, relayResponse{content: "let me look that up", toolCalls: []oaiToolCall{tc}})

	select {
	case r := <-resCh:
		if r.err != nil {
			t.Fatalf("Call returned error: %v", r.err)
		}
		if len(r.msg.ToolCalls) != 1 || r.msg.ToolCalls[0].Function.Name != "web_search" {
			t.Errorf("toolCalls = %+v, want one web_search", r.msg.ToolCalls)
		}
		if got := contentText(r.msg.Content); got != "let me look that up" {
			t.Errorf("content = %q, want the thinking preamble", got)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("browserRelay.Call did not return after tool-call response")
	}
}

// TestBrowserRelay_CallTimesOutOnContext verifies that a relay round aborts
// when its context is cancelled (a user stop or, for connection-bound local
// jobs, an SSE /events disconnect) and clears its pending channel so a late
// POST gets a 409 instead of delivering into a dead wait.
func TestBrowserRelay_CallTimesOutOnContext(t *testing.T) {
	j := newJob("conv", "user@example.com", "local:1b", false, false, false)
	mb := &browserRelay{j: j}

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()

	_, _, err := mb.Call(ctx, "local:1b",
		[]oaiMessage{{Role: "user", Content: jsonString("hi")}}, nil)
	if err == nil {
		t.Fatalf("expected a timeout/cancel error, got nil")
	}

	j.mu.Lock()
	pending := j.pendingRelay
	j.mu.Unlock()
	if pending != nil {
		t.Errorf("pendingRelay should be cleared after ctx cancel, got non-nil")
	}
}

// TestJob_EmitModelCallStashAndSnapshot covers the SSE replay mechanism: a
// modelCall is stashed on emit and returned by snapshot so a browser that
// attaches after the cue fired still runs the round, then cleared on response.
func TestJob_EmitModelCallStashAndSnapshot(t *testing.T) {
	j := newJob("conv", "user@example.com", "local:1b", false, false, false)
	j.emitModelCall("local:1b",
		[]oaiMessage{{Role: "user", Content: jsonString("hi")}},
		[]oaiTool{webSearchTool})

	mc := j.modelCallSnapshot()
	if mc == nil {
		t.Fatal("pendingModelCall should be stashed after emitModelCall")
	}
	if mc.JobID != j.id {
		t.Errorf("jobId = %q, want %q", mc.JobID, j.id)
	}
	if mc.Model != "local:1b" {
		t.Errorf("model = %q, want local:1b", mc.Model)
	}
	if len(mc.Messages) != 1 || contentText(mc.Messages[0].Content) != "hi" {
		t.Errorf("messages = %+v, want one user 'hi'", mc.Messages)
	}
	if len(mc.Tools) != 1 || mc.Tools[0].Function.Name != "web_search" {
		t.Errorf("tools = %+v, want [web_search]", mc.Tools)
	}

	j.clearPendingModelCall()
	if mc := j.modelCallSnapshot(); mc != nil {
		t.Errorf("pendingModelCall should be nil after clear, got %+v", mc)
	}
}

// TestJob_EmitModelCallOmitsEmptyTools confirms a plain-chat modelCall (no
// tools) leaves the tools field empty so it is omitted from the SSE payload —
// the frontend treats a missing tools field as "no tools" for a plain round.
func TestJob_EmitModelCallOmitsEmptyTools(t *testing.T) {
	j := newJob("conv", "u@e.com", "m", false, false, false)
	j.emitModelCall("m", []oaiMessage{{Role: "user", Content: jsonString("hi")}}, nil)
	mc := j.modelCallSnapshot()
	if mc == nil {
		t.Fatal("expected stashed modelCall")
	}
	if len(mc.Tools) != 0 {
		t.Errorf("tools should be empty for plain chat, got %d", len(mc.Tools))
	}
}

// TestHandleModelResponse_DeliversAndRejectsDuplicate exercises the HTTP
// endpoint end-to-end: a POST claiming the pending channel delivers the
// response, and a duplicate/late POST (channel already claimed) gets a 409.
func TestHandleModelResponse_DeliversAndRejectsDuplicate(t *testing.T) {
	st, err := newStore(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("newStore: %v", err)
	}
	defer st.close()
	srv := &server{store: st}
	srv.jobs = newJobManager(st, srv)

	j := newJob("conv-1", "user@example.com", "local:1b", false, false, false)
	j.local = true
	srv.jobs.mu.Lock()
	srv.jobs.active[j.convID] = j
	srv.jobs.mu.Unlock()
	t.Cleanup(func() {
		srv.jobs.mu.Lock()
		delete(srv.jobs.active, j.convID)
		srv.jobs.mu.Unlock()
	})

	// Arm a pending relay channel, as browserRelay.Call would mid-round.
	ch := make(chan relayResponse, 1)
	j.mu.Lock()
	j.pendingRelay = ch
	j.mu.Unlock()

	// A POST carrying content + a tool_call delivers to the pending channel.
	// httptest.NewRequest does not run the ServeMux, so PathValue("id") is empty
	// unless set explicitly (Go 1.22). Populate it to match the route pattern.
	body := bytes.NewReader([]byte(`{"jobId":"` + j.id + `","content":"hi there","tool_calls":[{"id":"tc1","type":"function","function":{"name":"web_search","arguments":"{\"query\":\"x\"}"}}]}`))
	req := httptest.NewRequest(http.MethodPost, "/api/conversations/conv-1/model-response", body)
	req.SetPathValue("id", "conv-1")
	req = req.WithContext(context.WithValue(req.Context(), ctxEmail, "user@example.com"))
	rec := httptest.NewRecorder()
	srv.handleModelResponse(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("first POST status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	select {
	case resp := <-ch:
		if resp.content != "hi there" {
			t.Errorf("delivered content = %q, want %q", resp.content, "hi there")
		}
		if len(resp.toolCalls) != 1 || resp.toolCalls[0].Function.Name != "web_search" {
			t.Errorf("delivered toolCalls = %+v, want one web_search", resp.toolCalls)
		}
	case <-time.After(time.Second):
		t.Fatalf("response not delivered to pending channel")
	}

	// A duplicate/late POST finds no pending call (it was claimed) → 409.
	req2 := httptest.NewRequest(http.MethodPost, "/api/conversations/conv-1/model-response",
		bytes.NewReader([]byte(`{"jobId":"`+j.id+`","content":"late"}`)))
	req2.SetPathValue("id", "conv-1")
	req2 = req2.WithContext(context.WithValue(req2.Context(), ctxEmail, "user@example.com"))
	rec2 := httptest.NewRecorder()
	srv.handleModelResponse(rec2, req2)
	if rec2.Code != http.StatusConflict {
		t.Errorf("second POST status = %d, want 409", rec2.Code)
	}
}

// TestBrowserRelay_CallReturnsError verifies that a relayResponse carrying a
// non-empty Error (a failed localhost fetch: 403 / connection refused) is
// returned as an error from Call — not treated as a successful empty answer —
// and that the stashed modelCall is cleared so a reconnect doesn't replay the
// failed round. No content is accumulated.
func TestBrowserRelay_CallReturnsError(t *testing.T) {
	j := newJob("conv", "user@example.com", "local:1b", false, false, false)
	mb := &browserRelay{j: j}

	type res struct {
		msg oaiMessage
		err error
	}
	resCh := make(chan res, 1)
	go func() {
		msg, _, err := mb.Call(context.Background(), "local:1b",
			[]oaiMessage{{Role: "user", Content: jsonString("hi")}}, nil)
		resCh <- res{msg, err}
	}()

	waitForRelay(t, j, 2*time.Second)
	claimRelay(t, j, relayResponse{Error: "local ollama rejected the request (403)"})

	select {
	case r := <-resCh:
		if r.err == nil {
			t.Fatalf("expected an error from Call, got nil")
		}
		if !strings.Contains(r.err.Error(), "local ollama rejected the request (403)") {
			t.Errorf("error = %q, want it to contain the relay error message", r.err.Error())
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("browserRelay.Call did not return after error response")
	}

	// No content was accumulated (the browser POSTs {error} with no content).
	if got := j.contentString(); got != "" {
		t.Errorf("accumulated content = %q, want empty on error", got)
	}
	// The pending modelCall was cleared so a reconnect doesn't replay a dead round.
	if mc := j.modelCallSnapshot(); mc != nil {
		t.Errorf("pendingModelCall should be cleared after error, got %+v", mc)
	}
}

// TestHandleModelResponse_DeliversError confirms a POST carrying {error:"..."}
// delivers the error through the pending channel (status 200), so the awaiting
// browserRelay.Call can surface it as an error.
func TestHandleModelResponse_DeliversError(t *testing.T) {
	st, err := newStore(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("newStore: %v", err)
	}
	defer st.close()
	srv := &server{store: st}
	srv.jobs = newJobManager(st, srv)

	j := newJob("conv-err", "user@example.com", "local:1b", false, false, false)
	srv.jobs.mu.Lock()
	srv.jobs.active[j.convID] = j
	srv.jobs.mu.Unlock()
	t.Cleanup(func() {
		srv.jobs.mu.Lock()
		delete(srv.jobs.active, j.convID)
		srv.jobs.mu.Unlock()
	})

	ch := make(chan relayResponse, 1)
	j.mu.Lock()
	j.pendingRelay = ch
	j.mu.Unlock()

	req := httptest.NewRequest(http.MethodPost, "/api/conversations/conv-err/model-response",
		bytes.NewReader([]byte(`{"jobId":"`+j.id+`","error":"no ollama on this computer"}`)))
	req.SetPathValue("id", "conv-err")
	req = req.WithContext(context.WithValue(req.Context(), ctxEmail, "user@example.com"))
	rec := httptest.NewRecorder()
	srv.handleModelResponse(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("error POST status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	select {
	case resp := <-ch:
		if resp.Error != "no ollama on this computer" {
			t.Errorf("delivered Error = %q, want the relay error message", resp.Error)
		}
		if resp.content != "" || len(resp.toolCalls) != 0 {
			t.Errorf("error POST should carry no content/tool_calls, got %+v", resp)
		}
	case <-time.After(time.Second):
		t.Fatalf("error response not delivered to pending channel")
	}
}

// TestHandleModelResponse_ErrorFinalizesJobAsError is the end-to-end check: a
// local-model job whose browser POSTs {error} finalizes as "error" (via the
// worker's notifyError path) and does NOT persist an empty assistant message —
// so the frontend's visible error text in the bubble is not replaced on reload.
func TestHandleModelResponse_ErrorFinalizesJobAsError(t *testing.T) {
	st, err := newStore(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("newStore: %v", err)
	}
	defer st.close()
	srv := &server{cfg: config{contextLength: 8192}, store: st}
	srv.jobs = newJobManager(st, srv)

	const email = "user@example.com"
	convID := "conv-e2e"
	if _, err := st.createConversation(email, convID, "t", "local:1b",
		[]Message{{Role: "user", Content: "hi"}}); err != nil {
		t.Fatalf("createConversation: %v", err)
	}

	j := newJob(convID, email, "local:1b", false, false, false)
	j.local = true
	if err := srv.jobs.enqueue(j); err != nil {
		t.Fatalf("enqueue: %v", err)
	}

	// Wait for the worker to arm the pending relay channel (browserRelay.Call).
	waitForRelay(t, j, 3*time.Second)

	// The browser POSTs {error} on a failed localhost fetch.
	req := httptest.NewRequest(http.MethodPost, "/api/conversations/conv-e2e/model-response",
		bytes.NewReader([]byte(`{"jobId":"`+j.id+`","error":"local ollama 403: rejected origin"}`)))
	req.SetPathValue("id", convID)
	req = req.WithContext(context.WithValue(req.Context(), ctxEmail, email))
	rec := httptest.NewRecorder()
	srv.handleModelResponse(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("error POST status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}

	// The worker should finalize the job as "error" (not done/cancelled).
	select {
	case <-j.finished:
	case <-time.After(5 * time.Second):
		t.Fatalf("job did not finalize after error POST")
	}
	status, _, errMsg := j.snapshot()
	if status != "error" {
		t.Errorf("job status = %q, want \"error\"", status)
	}
	if !strings.Contains(errMsg, "local ollama 403: rejected origin") {
		t.Errorf("job errMsg = %q, want it to contain the relay error", errMsg)
	}

	// No empty assistant message was appended — the conversation still holds only
	// the original user turn, so a frontend reload keeps the visible error bubble.
	conv, err := st.getConversation(email, convID)
	if err != nil {
		t.Fatalf("getConversation: %v", err)
	}
	if len(conv.Messages) != 1 || conv.Messages[0].Role != "user" {
		t.Errorf("conversation messages = %+v, want only the original user turn (no empty assistant)", conv.Messages)
	}
}

// TestHandleModelResponse_NoActiveJobOrWrongUser verifies the auth/correlation
// guards: 404 when there is no active job for the conversation, 404 when the
// job belongs to a different user, and 409 when the POST's jobId is stale.
func TestHandleModelResponse_NoActiveJobOrWrongUser(t *testing.T) {
	st, err := newStore(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("newStore: %v", err)
	}
	defer st.close()
	srv := &server{store: st}
	srv.jobs = newJobManager(st, srv)

	// No active job for this conversation → 404.
	req := httptest.NewRequest(http.MethodPost, "/api/conversations/none/model-response",
		bytes.NewReader([]byte(`{"jobId":"x","content":"hi"}`)))
	req.SetPathValue("id", "none")
	req = req.WithContext(context.WithValue(req.Context(), ctxEmail, "user@example.com"))
	rec := httptest.NewRecorder()
	srv.handleModelResponse(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Errorf("no-active-job status = %d, want 404", rec.Code)
	}

	// An active job for a different user → 404 (not 409) so a cross-user probe
	// cannot learn the job exists.
	j := newJob("conv-2", "owner@example.com", "local:1b", false, false, false)
	srv.jobs.mu.Lock()
	srv.jobs.active[j.convID] = j
	srv.jobs.mu.Unlock()
	t.Cleanup(func() {
		srv.jobs.mu.Lock()
		delete(srv.jobs.active, j.convID)
		srv.jobs.mu.Unlock()
	})
	req2 := httptest.NewRequest(http.MethodPost, "/api/conversations/conv-2/model-response",
		bytes.NewReader([]byte(`{"jobId":"`+j.id+`","content":"hi"}`)))
	req2.SetPathValue("id", "conv-2")
	req2 = req2.WithContext(context.WithValue(req2.Context(), ctxEmail, "intruder@example.com"))
	rec2 := httptest.NewRecorder()
	srv.handleModelResponse(rec2, req2)
	if rec2.Code != http.StatusNotFound {
		t.Errorf("wrong-user status = %d, want 404", rec2.Code)
	}

	// The right user but a stale jobId (a newer generation replaced the old) → 409.
	req3 := httptest.NewRequest(http.MethodPost, "/api/conversations/conv-2/model-response",
		bytes.NewReader([]byte(`{"jobId":"stale-id","content":"hi"}`)))
	req3.SetPathValue("id", "conv-2")
	req3 = req3.WithContext(context.WithValue(req3.Context(), ctxEmail, "owner@example.com"))
	rec3 := httptest.NewRecorder()
	srv.handleModelResponse(rec3, req3)
	if rec3.Code != http.StatusConflict {
		t.Errorf("stale-jobId status = %d, want 409", rec3.Code)
	}
}

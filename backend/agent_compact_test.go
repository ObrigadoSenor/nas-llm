package main

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

// bigStr returns an n-byte filler string used to bloat message content so
// estimateTokens crosses the compaction threshold (char/4 estimate).
func bigStr(n int) string {
	return strings.Repeat("x", n)
}

// buildBloatMsgs builds a transcript large enough to trip compaction at a small
// limit: a system prompt, then several big user/assistant/tool rounds. Tool
// results are paired with an assistant tool_call so the safe-cut logic never
// severs a pair.
func buildBloatMsgs() []oaiMessage {
	msgs := []oaiMessage{{Role: "system", Content: jsonString("you are an agent")}}
	for i := 0; i < 4; i++ {
		msgs = append(msgs, oaiMessage{Role: "user", Content: jsonString(bigStr(3000))})
		var tc oaiToolCall
		tc.ID = fmt.Sprintf("c%d", i)
		tc.Type = "function"
		tc.Function.Name = "get_time"
		tc.Function.Arguments = "{}"
		msgs = append(msgs, oaiMessage{Role: "assistant", ToolCalls: []oaiToolCall{tc}, Content: jsonString(bigStr(2000))})
		msgs = append(msgs, oaiMessage{Role: "tool", ToolCallID: tc.ID, Name: "get_time", Content: jsonString(bigStr(3500))})
	}
	msgs = append(msgs, oaiMessage{Role: "user", Content: jsonString("final question")})
	return msgs
}

// TestMaybeCompact_RelayTruncationOnly covers the browser-relay path: with
// summarize=false, compaction drops the head with a marker (no inference), keeps
// the system prompt + a verbatim tail with tool-call/result pairs intact, and
// never dials a target (empty URL is fine).
func TestMaybeCompact_RelayTruncationOnly(t *testing.T) {
	st, err := newStore(filepath.Join(t.TempDir(), "compact.db"))
	if err != nil {
		t.Fatalf("newStore: %v", err)
	}
	defer st.close()
	srv := &server{cfg: config{contextLength: 8192, agentRelayContextLength: 4096}, store: st}

	msgs := buildBloatMsgs()
	limit := 4096 // non-constant so the threshold conversion is runtime (truncating)
	threshold := int(float64(limit) * agentCompactFrac)
	before := estimateTokens(msgs)
	if before < threshold {
		t.Fatalf("test fixture too small: %d tokens, need > %d", before, threshold)
	}

	out := srv.maybeCompact(context.Background(), "", "m", msgs, 4096, false)

	if estimateTokens(out) >= before {
		t.Errorf("relay compaction did not shrink: before=%d after=%d", before, estimateTokens(out))
	}
	if len(out) == 0 || out[0].Role != "system" || contentText(out[0].Content) != "you are an agent" {
		t.Errorf("system prompt not preserved at out[0]: %+v", out)
	}
	// A marker system message must be present right after the system prompt.
	if len(out) < 2 || !strings.Contains(contentText(out[1].Content), "dropped to fit the context window") {
		t.Errorf("missing truncation marker after system prompt: %+v", out[:min(3, len(out))])
	}
	// The final user turn must survive in the tail.
	last := out[len(out)-1]
	if last.Role != "user" || contentText(last.Content) != "final question" {
		t.Errorf("final user turn not preserved: %+v", last)
	}
	// No tool result may appear without a preceding assistant tool_call (no
	// severed pairs): walk the tail and check every tool message is preceded by
	// an assistant carrying tool_calls.
	for i := range out {
		if out[i].Role != "tool" {
			continue
		}
		if i == 0 || len(out[i-1].ToolCalls) == 0 {
			t.Errorf("severed tool result at out[%d] (no preceding tool_calls): %+v", i, out[i])
		}
	}
}

// TestMaybeCompact_ServerSummarize covers the server path: with summarize=true,
// the dropped head is replaced by one summary system message produced by a
// non-streaming model call (served here by an httptest server).
func TestMaybeCompact_ServerSummarize(t *testing.T) {
	srvHTTP := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"choices":[{"message":{"content":"SUMMARY OF EARLIER WORK"}}]}`)
	}))
	defer srvHTTP.Close()

	st, err := newStore(filepath.Join(t.TempDir(), "compact-srv.db"))
	if err != nil {
		t.Fatalf("newStore: %v", err)
	}
	defer st.close()
	srv := &server{cfg: config{contextLength: 4096}, store: st}

	msgs := buildBloatMsgs()
	out := srv.maybeCompact(context.Background(), srvHTTP.URL, "m", msgs, 4096, true)

	if len(out) == 0 || out[0].Role != "system" || contentText(out[0].Content) != "you are an agent" {
		t.Errorf("system prompt not preserved: %+v", out[:min(3, len(out))])
	}
	if len(out) < 2 || !strings.Contains(contentText(out[1].Content), "summary of older turns") ||
		!strings.Contains(contentText(out[1].Content), "SUMMARY OF EARLIER WORK") {
		t.Errorf("summary system message not inserted at out[1]: %+v", out[:min(3, len(out))])
	}
	// The tail still ends with the final user turn.
	if last := out[len(out)-1]; last.Role != "user" || contentText(last.Content) != "final question" {
		t.Errorf("final user turn not preserved: %+v", last)
	}
	// Compaction actually reduced the transcript.
	if estimateTokens(out) >= estimateTokens(msgs) {
		t.Errorf("server compaction did not shrink: before=%d after=%d", estimateTokens(msgs), estimateTokens(out))
	}
}

// TestMaybeCompact_UnderThresholdNoop confirms a small transcript is returned
// unchanged for both modes (no work, no marker, no summary call).
func TestMaybeCompact_UnderThresholdNoop(t *testing.T) {
	st, err := newStore(filepath.Join(t.TempDir(), "compact-noop.db"))
	if err != nil {
		t.Fatalf("newStore: %v", err)
	}
	defer st.close()
	srv := &server{cfg: config{contextLength: 8192}, store: st}

	msgs := []oaiMessage{
		{Role: "system", Content: jsonString("sys")},
		{Role: "user", Content: jsonString("hi")},
	}
	if got := srv.maybeCompact(context.Background(), "", "m", msgs, 8192, false); len(got) != 2 {
		t.Errorf("relay noop changed message count: got %d, want 2", len(got))
	}
	if got := srv.maybeCompact(context.Background(), "http://unused", "m", msgs, 8192, true); len(got) != 2 {
		t.Errorf("server noop changed message count: got %d, want 2", len(got))
	}
}

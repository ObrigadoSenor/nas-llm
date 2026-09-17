package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
)

// enough to trigger compaction before Ollama's context window overflows. It
// counts content text plus accumulated tool-call arguments.
func estimateTokens(msgs []oaiMessage) int {
	n := 0
	for _, m := range msgs {
		if len(m.Content) > 0 {
			var s string
			if json.Unmarshal(m.Content, &s) == nil {
				n += len(s)
			} else {
				n += len(m.Content)
			}
		}
		for _, tc := range m.ToolCalls {
			n += len(tc.Function.Name) + len(tc.Function.Arguments)
		}
	}
	return n / 4
}

// truncateOldToolResults caps every tool-result observation except the last few
// to a short prefix. Tool results are self-contained (each carries its
// tool_call_id), so truncating their content never breaks the call/result
// pairing — this is always safe and cheaply bounds context growth.
func truncateOldToolResults(msgs []oaiMessage, keepLast int) []oaiMessage {
	toolIdxs := []int{}
	for i, m := range msgs {
		if m.Role == "tool" {
			toolIdxs = append(toolIdxs, i)
		}
	}
	if len(toolIdxs) <= keepLast {
		return msgs
	}
	trim := toolIdxs[:len(toolIdxs)-keepLast]
	for _, i := range trim {
		var s string
		if json.Unmarshal(msgs[i].Content, &s) == nil && len(s) > agentToolTrimChars {
			msgs[i].Content = jsonString(s[:agentToolTrimChars] + "\n…[older result truncated]")
		}
	}
	return msgs
}

// summarizeTurns asks the model (non-streaming) to compress a slice of older
// text turns into a short summary. It is the expensive phase of compaction; the
// caller keeps the most recent tail verbatim so in-flight tool pairs stay intact.
func (s *server) summarizeTurns(ctx context.Context, target, model string, msgs []oaiMessage) (string, error) {
	var b strings.Builder
	for _, m := range msgs {
		if len(m.Content) == 0 {
			continue
		}
		var text string
		if json.Unmarshal(m.Content, &text) != nil {
			continue // non-text (e.g. image parts) — skip
		}
		role := m.Role
		if role == "" {
			role = "turn"
		}
		fmt.Fprintf(&b, "%s: %s\n", role, text)
	}
	if b.Len() == 0 {
		return "", nil
	}
	payload, _ := json.Marshal(chatRequest{
		Model:  model,
		Stream: false,
		Messages: []oaiMessage{
			{Role: "system", Content: jsonString("Summarize the following earlier conversation turns in under 200 words. Preserve concrete facts, numbers, tool results, and which files were edited or created (with the nature of each change). Do not add new information.")},
			{Role: "user", Content: jsonString(b.String())},
		},
	})
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader(payload))
	if err != nil {
		return "", err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Host = "localhost:11434"
	httpReq.Header.Del("Origin")
	httpReq.Header.Del("Referer")
	resp, err := http.DefaultClient.Do(httpReq)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("summary model error: %s", resp.Status)
	}
	var out struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", err
	}
	if len(out.Choices) == 0 || out.Choices[0].Message.Content == "" {
		return "", errors.New("empty summary")
	}
	summary := out.Choices[0].Message.Content
	if len(summary) > agentSummaryMaxChars {
		summary = summary[:agentSummaryMaxChars] + "…"
	}
	return summary, nil
}

// maybeCompact bounds the running transcript within the context window. It first
// truncates old tool-result observations (cheap, always safe). If still over the
// threshold it drops the oldest turns up to a safe cut (never severing a
// tool-call/result pair), keeping the system prompt + a verbatim tail.
//
// For a server backend (summarize=true, target set) the dropped head is compressed
// into one summary system message via a non-streaming model call; summarization
// failure is non-fatal (falls back to the truncated list). For a browser-relay
// backend (summarize=false) the head is dropped with a short marker instead — a
// summary would need an extra inference round on the visitor's Ollama and stream
// into the answer bubble — and a final pass caps every remaining tool result so a
// single big recent observation can't blow the small local window.
//
// limit is the assumed context window (cfg.contextLength for server models,
// cfg.agentRelayContextLength for local models, which the backend can't introspect).
func (s *server) maybeCompact(ctx context.Context, target, model string, msgs []oaiMessage, limit int, summarize bool) []oaiMessage {
	if limit <= 0 {
		limit = 8192
	}
	threshold := int(float64(limit) * agentCompactFrac)
	if estimateTokens(msgs) < threshold {
		return msgs
	}
	msgs = truncateOldToolResults(msgs, 2)
	if estimateTokens(msgs) < threshold {
		return msgs
	}
	if len(msgs) <= agentTailMin+1 {
		return msgs // too short to split safely
	}
	// Walk back from the end to a safe cut: never land on a tool result or an
	// assistant turn that carries tool_calls (its results would be severed). Keep
	// at least agentTailMin messages in the tail.
	cut := len(msgs) - agentTailMin
	for cut > 1 && (msgs[cut].Role == "tool" || len(msgs[cut].ToolCalls) > 0) {
		cut--
	}
	if cut <= 1 {
		return msgs
	}
	if summarize {
		head := msgs[1:cut]
		summary, err := s.summarizeTurns(ctx, target, model, head)
		if err != nil || strings.TrimSpace(summary) == "" {
			return msgs // summarization failed — run as-is
		}
		out := make([]oaiMessage, 0, len(msgs)-cut+3)
		out = append(out, msgs[0]) // original system prompt
		out = append(out, oaiMessage{Role: "system", Content: jsonString("Earlier in this task (summary of older turns): " + summary)})
		out = append(out, msgs[cut:]...)
		return out
	}
	// Truncation-only (browser relay): drop the head with a marker, then cap every
	// remaining tool result so a big recent observation can't alone overflow the
	// small local window. No extra inference.
	out := make([]oaiMessage, 0, len(msgs)-cut+2)
	out = append(out, msgs[0]) // original system prompt
	out = append(out, oaiMessage{Role: "system", Content: jsonString("Earlier turns were dropped to fit the context window; the recent activity follows.")})
	out = append(out, msgs[cut:]...)
	out = truncateOldToolResults(out, 1)
	return out
}

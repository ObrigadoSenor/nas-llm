package main

import (
	"context"
	"encoding/json"
	"errors"
	"time"
)

// modelBackend abstracts one round of model inference so the generation loops
// (plain / web-search / clarify / agent) can drive either a server-side Ollama
// host or a visitor's local Ollama relayed through the browser, without each
// loop branching on where the model runs.
//
// Call performs one assistant turn and returns the assembled OpenAI message
// (content + tool_calls) plus token usage. For a server-side backend, content
// deltas are also streamed live to the job as they arrive (via the emit wired
// into the backend) so the UI paints token-by-token. For a browser-relay
// backend, the browser streams the model output into the answer bubble directly
// from localhost and Call returns the assembled text WITHOUT re-emitting chunk
// events — the backend must not double-stream local-model content.
// agentSampling carries the sampling parameters applied to every inference
// round of an agent/search/clarify run. It is nil for plain-chat turns (which
// stay on Ollama's Modelfile defaults). Sent as top-level OpenAI fields
// (temperature/top_p/seed) on /v1/chat/completions — the only reliable way to
// control temperature on Ollama's OpenAI shim, which otherwise ignores the
// Modelfile's PARAMETER temperature (ollama/ollama#17744). seed == 0 means
// unset (no seed sent).
type agentSampling struct {
	temperature float64
	topP        float64
	seed        int64
}

type modelBackend interface {
	Call(ctx context.Context, model string, messages []oaiMessage, tools []oaiTool) (oaiMessage, agentUsage, error)
}

// directOllama is the existing server-model backend: it dials the resolved
// host's OpenAI chat-completions URL and streams content deltas to the job as
// they arrive. Tool-call deltas are accumulated into the returned assistant
// message for the next round. This is unchanged behavior for NAS/Mac models.
type directOllama struct {
	chatURL  string
	emit     func(string)   // live content deltas → job broadcast (j.emitChunk)
	sampling *agentSampling // nil for plain chat → Ollama Modelfile defaults
}

func (d *directOllama) Call(ctx context.Context, model string, messages []oaiMessage, tools []oaiTool) (oaiMessage, agentUsage, error) {
	req := chatRequest{
		Model:         model,
		Messages:      messages,
		Tools:         tools,
		StreamOptions: map[string]any{"include_usage": true},
	}
	if d.sampling != nil {
		t := d.sampling.temperature
		p := d.sampling.topP
		req.Temperature = &t
		req.TopP = &p
		if d.sampling.seed != 0 {
			s := d.sampling.seed
			req.Seed = &s
		}
	}
	return streamOllamaChatWithTools(ctx, d.chatURL, &req, d.emit)
}

// agentBackendInfo returns the backend kind ("server"/"relay") and the
// per-run sampling config for a modelBackend, used by the opt-in debug
// capture so a replayed round carries the same sampling that was actually
// applied. Returns "unknown", nil for any other backend (e.g. a test fake).
func agentBackendInfo(mb modelBackend) (string, *agentSampling) {
	switch v := mb.(type) {
	case *directOllama:
		return "server", v.sampling
	case *browserRelay:
		return "relay", v.j.sampling
	}
	return "unknown", nil
}

// browserRelay is the local-model backend. The NAS backend cannot dial the
// visitor's localhost:11434, so the browser does: Call emits a `modelCall` SSE
// event on the job (the browser's cue to fetch its own Ollama and stream the
// output into the answer bubble), then awaits the browser's POST
// /model-response on a per-job pending-response channel. It does NOT emit
// content as chunk events — the browser streams the model output directly.
// The assembled content is appended to the job (without broadcasting) so it is
// persisted to SQLite and replayed on SSE reconnect, matching what directOllama
// accumulates via emitChunk.
type browserRelay struct {
	j *job
}

func (b *browserRelay) Call(ctx context.Context, model string, messages []oaiMessage, tools []oaiTool) (oaiMessage, agentUsage, error) {
	respCh := make(chan relayResponse, 1)
	b.j.mu.Lock()
	b.j.pendingRelay = respCh
	b.j.mu.Unlock()

	// Clear our channel on the way out so a late/duplicate browser POST finds no
	// pending call (and gets a 409), and so a timeout/abort doesn't leave a
	// dangling channel for a later POST to deliver into.
	defer func() {
		b.j.mu.Lock()
		if b.j.pendingRelay == respCh {
			b.j.pendingRelay = nil
		}
		b.j.mu.Unlock()
	}()

	b.j.emitModelCall(model, messages, tools)

	// Reuse the per-generation timeout as the bound on the browser round-trip
	// (the visitor's model + the POST leg). ctx carries the job's cancel: a user
	// stop, or — for connection-bound local jobs — an SSE /events disconnect.
	timer := time.NewTimer(genTimeout)
	defer timer.Stop()
	select {
	case resp, ok := <-respCh:
		if !ok {
			return oaiMessage{}, agentUsage{}, errors.New("local model response cancelled")
		}
		// A failed localhost fetch (403 / connection refused): the browser POSTs
		// {error:"..."} with no content. Surface it as an error so the worker
		// finalizes the job as "error" (via notifyError) and does NOT persist an
		// empty assistant message — which would make onGenerationDone reload and
		// replace the visible error text in the bubble. Clear the stashed modelCall
		// so a reconnect doesn't replay a failed round.
		if resp.Error != "" {
			b.j.clearPendingModelCall()
			return oaiMessage{}, agentUsage{}, errors.New(resp.Error)
		}
		b.j.clearPendingModelCall()
		b.j.appendContent(resp.content)
		msg := oaiMessage{Role: "assistant", ToolCalls: resp.toolCalls}
		if resp.content != "" {
			msg.Content = jsonString(resp.content)
		}
		// A genuinely empty relay reply is not an error the way an empty Ollama
		// stream is — the loop emits a synthetic "(no response)" fallback so the
		// user sees a clean bubble instead of a failed job.
		return msg, agentUsage{}, nil
	case <-timer.C:
		return oaiMessage{}, agentUsage{}, errors.New("local model response timed out")
	case <-ctx.Done():
		return oaiMessage{}, agentUsage{}, ctx.Err()
	}
}

// contentText decodes an oaiMessage.Content (a JSON-encoded string as produced
// by jsonString) into plain text. Returns "" for empty or non-text content
// (e.g. an image-part array). Used by the loops to read a round's assembled
// text for thinking-drawer handling and empty-response fallbacks.
func contentText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	return ""
}

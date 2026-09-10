package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

const (
	searchResultCount  = 3
	searchSnippetChars = 200
	searchCallTimeout  = 200 * time.Second
)

// searxngClient is reused across web_search calls for connection pooling. The
// 15s timeout is a backstop; SearXNG's own outgoing max_request_timeout bounds
// the actual search latency.
var searxngClient = &http.Client{Timeout: 15 * time.Second}

// --- OpenAI chat schema (the subset we manipulate) -------------------------

type oaiMessage struct {
	Role       string          `json:"role"`
	Content    json.RawMessage `json:"content,omitempty"`
	ToolCalls  []oaiToolCall   `json:"tool_calls,omitempty"`
	ToolCallID string          `json:"tool_call_id,omitempty"`
	Name       string          `json:"name,omitempty"`
}

type oaiToolCall struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}

type oaiToolFunction struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	Parameters  map[string]any `json:"parameters"`
}

type oaiTool struct {
	Type     string          `json:"type"`
	Function oaiToolFunction `json:"function"`
}

// chatRequest is the body we accept from the browser. Unknown fields are
// ignored; for the search path we re-marshal only model/messages/stream/tools.
type chatRequest struct {
	Model     string       `json:"model"`
	Messages  []oaiMessage `json:"messages"`
	Stream    bool         `json:"stream"`
	WebSearch bool         `json:"web_search"`
	Tools     []oaiTool    `json:"tools,omitempty"`
}

var webSearchTool = oaiTool{
	Type: "function",
	Function: oaiToolFunction{
		Name:        "web_search",
		Description: "Search the web for current or time-sensitive information that may be past your training cutoff. Returns titles, URLs, and short snippets. Use it only when the question needs fresh facts; otherwise answer directly.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"query": map[string]any{
					"type":        "string",
					"description": "The web search query.",
				},
			},
			"required": []string{"query"},
		},
	},
}

func systemNudge() oaiMessage {
	return oaiMessage{Role: "system", Content: jsonString(
		"You have a web_search tool for current or time-sensitive facts that may be past your training cutoff. " +
			"Call it once with a well-formed query, then synthesize your answer directly from the results — do not search again. " +
			"Only call it when the answer needs fresh information; otherwise answer directly. " +
			"When you do search, cite the source URLs in your answer and say when you could not verify something.")}
}

// jsonString returns a JSON-encoded string as RawMessage (safe to drop into
// oaiMessage.Content).
func jsonString(s string) json.RawMessage {
	b, _ := json.Marshal(s)
	return json.RawMessage(b)
}

// runSearchLoop runs the web_search tool-calling loop and emits the final
// answer through emit. It is detached from any HTTP response: the caller
// (job worker or handleChatWithSearch) wires emit to its output sink.
// emitPhase("searching"/"answering") is a hint the UI can use. Returns nil on
// success, an error otherwise.
func (s *server) runSearchLoop(ctx context.Context, model string, msgs []oaiMessage, emit func(string), emitPhase func(string)) error {
	emitPhase("searching")
	ollamaChatURL := strings.TrimRight(s.cfg.ollamaURL, "/") + "/v1/chat/completions"
	req := chatRequest{
		Model:    model,
		Messages: append([]oaiMessage{systemNudge()}, msgs...),
		Tools:    []oaiTool{webSearchTool},
	}

	for round := 0; round < s.cfg.maxSearchRounds; round++ {
		// Stream the tool-calling pass so any content the model produces before
		// deciding to search (or instead of searching) reaches the UI live,
		// rather than after a blocking non-streaming round-trip. tool_call
		// deltas are accumulated into one assistant message for the next round.
		msg, err := s.streamOllamaChatWithTools(ctx, ollamaChatURL, &req, emit)
		if err != nil {
			return fmt.Errorf("search failed: %w", err)
		}
		if len(msg.ToolCalls) == 0 {
			// The model answered without (further) searching: its content was
			// already streamed above. Guard the empty case.
			if len(msg.Content) == 0 {
				emitPhase("answering")
				emit("(no response)")
			}
			return nil
		}
		// Echo the assistant tool_calls, then append tool results. Searches in a
		// single round run concurrently (ordered results preserve the API's
		// tool_call_id alignment); the query is echoed to the UI as it fires.
		req.Messages = append(req.Messages, msg)
		results := make([]string, len(msg.ToolCalls))
		var wg sync.WaitGroup
		for i, tc := range msg.ToolCalls {
			if tc.Function.Name != "web_search" {
				results[i] = "unknown tool"
				continue
			}
			var args struct {
				Query string `json:"query"`
			}
			if json.Unmarshal([]byte(tc.Function.Arguments), &args) == nil {
				q := strings.ReplaceAll(strings.TrimSpace(args.Query), "\n", " ")
				if len(q) > 80 {
					q = q[:80] + "…"
				}
				if q != "" {
					emitPhase("searching:" + q)
				}
			}
			wg.Add(1)
			go func(i int, argsJSON string) {
				defer wg.Done()
				results[i] = s.runWebSearch(argsJSON)
			}(i, tc.Function.Arguments)
		}
		wg.Wait()
		for i, tc := range msg.ToolCalls {
			req.Messages = append(req.Messages, oaiMessage{
				Role:       "tool",
				ToolCallID: tc.ID,
				Name:       tc.Function.Name,
				Content:    jsonString(results[i]),
			})
		}
	}

	// Round limit exhausted (the model kept wanting to search): force one final
	// streamed answer with the tools removed so it must synthesize.
	req.Tools = nil
	emitPhase("answering")
	return s.streamFromOllama(ctx, ollamaChatURL, &req, emit)
}

// streamOllamaChatWithTools POSTs a streaming chat completion, pipes content
// deltas to emit, and accumulates OpenAI-format tool_call deltas into one
// assembled assistant message (content + tool_calls) returned for the next
// round's context. Streaming the tool-calling pass — replacing the old blocking
// non-streaming call — lets the model's preamble, or a full answer when it
// decides not to search, reach the UI as it is produced instead of after the
// whole response is generated. Host is forced to localhost:11434 and
// Origin/Referer stripped, mirroring streamFromOllama (Ollama 403s non-localhost
// Hosts and any request carrying an Origin).
//
// Ollama streams each tool call as a complete delta (id + name + full
// arguments in one chunk), so we accumulate by arrival order: a delta carrying
// a new id starts a new call, a delta with no id is a continuation fragment of
// the previous call. Keying on id presence (rather than index) stays correct
// even when Ollama emits index:0 for every call in a multi-call response.
func (s *server) streamOllamaChatWithTools(ctx context.Context, target string, req *chatRequest, emit func(string)) (oaiMessage, error) {
	req.Stream = true
	payload, err := json.Marshal(req)
	if err != nil {
		return oaiMessage{}, err
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader(payload))
	if err != nil {
		return oaiMessage{}, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Host = "localhost:11434"
	httpReq.Header.Del("Origin")
	httpReq.Header.Del("Referer")
	resp, err := http.DefaultClient.Do(httpReq)
	if err != nil {
		return oaiMessage{}, fmt.Errorf("model request failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return oaiMessage{}, fmt.Errorf("model error: %s", resp.Status)
	}

	type tcAccum struct {
		id, typ, name string
		args          strings.Builder
	}
	var calls []tcAccum
	var content strings.Builder
	br := bufio.NewReader(resp.Body)
	for {
		line, err := br.ReadBytes('\n')
		if len(line) > 0 {
			t := strings.TrimSpace(string(line))
			if strings.HasPrefix(t, "data: ") {
				data := t[6:]
				if data == "[DONE]" {
					break
				}
				var chunk struct {
					Choices []struct {
						Delta struct {
							Content   string `json:"content"`
							ToolCalls []struct {
								ID       string `json:"id"`
								Type     string `json:"type"`
								Function struct {
									Name      string `json:"name"`
									Arguments string `json:"arguments"`
								} `json:"function"`
							} `json:"tool_calls"`
						} `json:"delta"`
					} `json:"choices"`
				}
				if json.Unmarshal([]byte(data), &chunk) == nil && len(chunk.Choices) > 0 {
					d := chunk.Choices[0].Delta
					if c := d.Content; c != "" {
						content.WriteString(c)
						emit(c)
					}
					for _, tc := range d.ToolCalls {
						if tc.ID != "" {
							c := tcAccum{id: tc.ID, typ: tc.Type, name: tc.Function.Name}
							c.args.WriteString(tc.Function.Arguments)
							calls = append(calls, c)
						} else if len(calls) > 0 {
							c := &calls[len(calls)-1]
							if tc.Type != "" {
								c.typ = tc.Type
							}
							if tc.Function.Name != "" {
								c.name = tc.Function.Name
							}
							if tc.Function.Arguments != "" {
								c.args.WriteString(tc.Function.Arguments)
							}
						}
					}
				}
			}
		}
		if err != nil {
			if err == io.EOF {
				break
			}
			// A dropped connection after we already have content or tool calls is
			// tolerable (treat like [DONE]); otherwise it's a hard error.
			if content.Len() == 0 && len(calls) == 0 {
				return oaiMessage{}, fmt.Errorf("connection lost: %w", err)
			}
			break
		}
	}

	msg := oaiMessage{Role: "assistant"}
	if content.Len() > 0 {
		msg.Content = jsonString(content.String())
	}
	for i := range calls {
		tc := oaiToolCall{ID: calls[i].id, Type: calls[i].typ}
		tc.Function.Name = calls[i].name
		tc.Function.Arguments = calls[i].args.String()
		msg.ToolCalls = append(msg.ToolCalls, tc)
	}
	if content.Len() == 0 && len(calls) == 0 {
		return msg, errors.New("empty response from model")
	}
	return msg, nil
}

// runWebSearch queries SearXNG and returns formatted result snippets.
func (s *server) runWebSearch(argsJSON string) string {
	var args struct {
		Query string `json:"query"`
	}
	if err := json.Unmarshal([]byte(argsJSON), &args); err != nil || strings.TrimSpace(args.Query) == "" {
		return "No search query provided."
	}
	searchURL := strings.TrimRight(s.cfg.searxngURL, "/") + "/search?q=" + url.QueryEscape(args.Query) + "&format=json"
	req, err := http.NewRequest(http.MethodGet, searchURL, nil)
	if err != nil {
		return "Search backend misconfigured."
	}
	resp, err := searxngClient.Do(req)
	if err != nil {
		log.Printf("web_search: %v", err)
		return "Search failed: " + err.Error()
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Sprintf("Search backend returned %s.", resp.Status)
	}
	var sr struct {
		Results []struct {
			Title   string `json:"title"`
			URL     string `json:"url"`
			Content string `json:"content"`
		} `json:"results"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&sr); err != nil {
		return "Search returned unreadable results."
	}
	if len(sr.Results) == 0 {
		return "No results found."
	}
	var b strings.Builder
	for i, r := range sr.Results {
		if i >= searchResultCount {
			break
		}
		snippet := strings.TrimSpace(r.Content)
		if len(snippet) > searchSnippetChars {
			snippet = snippet[:searchSnippetChars] + "…"
		}
		fmt.Fprintf(&b, "[%d] %s\n    %s\n    %s\n\n", i+1, r.Title, r.URL, snippet)
	}
	return b.String()
}

// handleChatWithSearch serves the legacy /api/chat/completions web_search path,
// emitting OpenAI-format SSE. The tool loop itself lives in runSearchLoop; here
// we only wire it to the ResponseWriter with a keepalive goroutine so the
// Cloudflare 100s edge timeout (524) never fires while the N100 thinks.
func (s *server) handleChatWithSearch(w http.ResponseWriter, r *http.Request, body []byte) {
	var req chatRequest
	if err := json.Unmarshal(body, &req); err != nil {
		jsonError(w, "invalid request", http.StatusBadRequest)
		return
	}

	flusher, _ := w.(http.Flusher)
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache")
	h.Set("X-Accel-Buffering", "no")
	h.Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	if flusher != nil {
		flusher.Flush()
	}

	var mu sync.Mutex
	write := func(str string) {
		mu.Lock()
		_, _ = io.WriteString(w, str)
		if flusher != nil {
			flusher.Flush()
		}
		mu.Unlock()
	}

	stop := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		t := time.NewTicker(keepaliveEvery)
		defer t.Stop()
		for {
			select {
			case <-stop:
				return
			case <-t.C:
				write(": searching…\n\n")
			}
		}
	}()

	emit := func(delta string) {
		if delta == "" {
			return
		}
		chunk := map[string]any{
			"choices": []map[string]any{{
				"index": 0,
				"delta": map[string]any{"content": delta},
			}},
		}
		j, _ := json.Marshal(chunk)
		write("data: " + string(j) + "\n\n")
	}
	emitPhase := func(string) {} // keepalive comment already covers the waiting state

	ctx, cancel := context.WithTimeout(r.Context(), searchCallTimeout)
	defer cancel()

	err := s.runSearchLoop(ctx, req.Model, req.Messages, emit, emitPhase)
	close(stop)
	wg.Wait()

	if err != nil {
		chunk := map[string]any{
			"choices": []map[string]any{{
				"index":         0,
				"delta":         map[string]any{"content": "⚠️ " + err.Error()},
				"finish_reason": "stop",
			}},
		}
		j, _ := json.Marshal(chunk)
		write("data: " + string(j) + "\n\n")
	}
	write("data: [DONE]\n\n")
}

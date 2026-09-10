package main

import (
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

type oaiChoice struct {
	Message      oaiMessage `json:"message"`
	FinishReason string     `json:"finish_reason,omitempty"`
}

type oaiChatResponse struct {
	Choices []oaiChoice `json:"choices"`
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
		Stream:   false, // non-streaming internally so we can parse tool_calls
		Tools:    []oaiTool{webSearchTool},
	}

	for round := 0; round < s.cfg.maxSearchRounds; round++ {
		oresp, err := s.callOllamaChatCtx(ctx, ollamaChatURL, &req)
		if err != nil {
			return fmt.Errorf("search failed: %w", err)
		}
		if len(oresp.Choices) == 0 {
			return errors.New("empty response from model")
		}
		msg := oresp.Choices[0].Message
		if len(msg.ToolCalls) == 0 {
			// The model answered without (further) searching: emit its text and finish.
			var content string
			if len(msg.Content) > 0 {
				_ = json.Unmarshal(msg.Content, &content)
			}
			if strings.TrimSpace(content) == "" {
				content = "(no response)"
			}
			emitPhase("answering")
			emit(content)
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

// callOllamaChatCtx makes a non-streaming chat-completions call to Ollama on the
// given context and returns the decoded response. Host is forced to
// localhost:11434 (Ollama 403s non-localhost Hosts) and Origin/Referer stripped.
func (s *server) callOllamaChatCtx(ctx context.Context, target string, req *chatRequest) (*oaiChatResponse, error) {
	req.Stream = false
	payload, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Host = "localhost:11434"
	httpReq.Header.Del("Origin")
	httpReq.Header.Del("Referer")
	resp, err := http.DefaultClient.Do(httpReq)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("ollama %s", resp.Status)
	}
	var o oaiChatResponse
	if err := json.NewDecoder(resp.Body).Decode(&o); err != nil {
		return nil, fmt.Errorf("decode: %w", err)
	}
	return &o, nil
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

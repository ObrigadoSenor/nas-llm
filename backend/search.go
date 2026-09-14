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
	searchSnippetChars = 280
	searchCallTimeout  = 200 * time.Second
)

// searxngClient is reused across web_search calls for connection pooling. The
// 15s timeout is a backstop; SearXNG's own outgoing max_request_timeout bounds
// the actual search latency.
var searxngClient = &http.Client{Timeout: 15 * time.Second}

// --- Web-search evidence (emitted to the UI + persisted on the message) ---
// searchSource is one result URL the user can click to verify a search happened.
type searchSource struct {
	Title   string `json:"title"`
	URL     string `json:"url"`
	Snippet string `json:"snippet,omitempty"`
}

// searchEntry is one search event: a real query + its top hits, or a Skipped
// marker explaining why no search ran (model declined / backend unconfigured).
type searchEntry struct {
	Query   string         `json:"query,omitempty"`
	Sources []searchSource `json:"sources,omitempty"`
	Skipped bool           `json:"skipped,omitempty"`
	Reason  string         `json:"reason,omitempty"`
}

// searchMeta is the full per-message search record, persisted on Message.Search.
type searchMeta struct {
	Searches []searchEntry `json:"searches,omitempty"`
}

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
	Model         string         `json:"model"`
	Messages      []oaiMessage   `json:"messages"`
	Stream        bool           `json:"stream"`
	WebSearch     bool           `json:"web_search"`
	Tools         []oaiTool      `json:"tools,omitempty"`
	StreamOptions map[string]any `json:"stream_options,omitempty"`
}

// agentUsage is the token accounting for one model round (parsed from Ollama's
// final streaming chunk when stream_options.include_usage is set). The agent
// loop accumulates it across rounds for observability.
type agentUsage struct {
	PromptTokens     int
	CompletionTokens int
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
			"When you do search, cite the source URLs in your answer and say when you could not verify something. " +
			"\n\n" + toolCallDiscipline())}
}

// jsonString returns a JSON-encoded string as RawMessage (safe to drop into
// oaiMessage.Content).
func jsonString(s string) json.RawMessage {
	b, _ := json.Marshal(s)
	return json.RawMessage(b)
}

// runSearchLoop runs the web_search tool-calling loop and emits the final
// answer through emit. It is detached from any HTTP response: the caller
// (job worker or handleChatWithSearch) wires emit to its output sink and
// supplies the modelBackend that performs each inference round (a direct dial
// to a server Ollama, or a browser relay for a local model).
// emitPhase("searching"/"answering") is a hint the UI can use; emitSearch fires
// once per real search (query + source URLs) so the UI can prove a lookup ran,
// or a Skipped entry when the model answers without ever calling the tool.
// Returns nil on success, an error otherwise.
func (s *server) runSearchLoop(ctx context.Context, mb modelBackend, model string, msgs []oaiMessage, emit func(string), emitPhase func(string), emitSearch func(searchEntry)) error {
	emitPhase("searching")
	messages := append([]oaiMessage{systemNudge()}, msgs...)
	tools := []oaiTool{webSearchTool}

	searched := false
	for round := 0; round < s.cfg.maxSearchRounds; round++ {
		// One tool-calling round. For a server backend, any preamble the model
		// produces before deciding to search (or instead of searching) streams
		// live to the UI; tool_calls are accumulated into the returned assistant
		// message for the next round. For a browser relay, the browser streams
		// the preamble directly and Call returns the assembled text + tool_calls.
		msg, _, err := mb.Call(ctx, model, messages, tools)
		if err != nil {
			return fmt.Errorf("search failed: %w", err)
		}
		if len(msg.ToolCalls) == 0 {
			// The model answered without (further) searching: its content was
			// already streamed above. Transition to "answering" so the UI drops
			// any live "searching" indicator and a reconnect replays the right
			// phase (not a stale "searching:…").
			emitPhase("answering")
			if contentText(msg.Content) == "" {
				emit("(no response)")
			}
			if !searched {
				// Web search was on but the model never called the tool — tell the
				// UI so it can show the answer is from training data, not a lookup.
				emitSearch(searchEntry{Skipped: true, Reason: "model answered without searching"})
			}
			return nil
		}
		// Echo the assistant tool_calls, then append tool results. Searches in a
		// single round run concurrently (ordered results preserve the API's
		// tool_call_id alignment); the query is echoed to the UI as it fires.
		messages = append(messages, msg)
		type searchOut struct {
			snippet string
			hits    []searchSource
		}
		results := make([]searchOut, len(msg.ToolCalls))
		queries := make([]string, len(msg.ToolCalls))
		var wg sync.WaitGroup
		for i, tc := range msg.ToolCalls {
			if tc.Function.Name != "web_search" {
				results[i] = searchOut{snippet: "unknown tool"}
				continue
			}
			searched = true
			var args struct {
				Query string `json:"query"`
			}
			if json.Unmarshal([]byte(tc.Function.Arguments), &args) == nil {
				q := strings.ReplaceAll(strings.TrimSpace(args.Query), "\n", " ")
				if len(q) > 80 {
					q = q[:80] + "…"
				}
				queries[i] = q
				if q != "" {
					emitPhase("searching:" + q)
				}
			}
			wg.Add(1)
			go func(i int, argsJSON string) {
				defer wg.Done()
				snip, hits := s.runWebSearch(argsJSON)
				results[i] = searchOut{snippet: snip, hits: hits}
			}(i, tc.Function.Arguments)
		}
		wg.Wait()
		for i, tc := range msg.ToolCalls {
			if tc.Function.Name == "web_search" && queries[i] != "" {
				emitSearch(searchEntry{Query: queries[i], Sources: results[i].hits})
			}
			messages = append(messages, oaiMessage{
				Role:       "tool",
				ToolCallID: tc.ID,
				Name:       tc.Function.Name,
				Content:    jsonString(results[i].snippet),
			})
		}
	}

	// Round limit exhausted (the model kept wanting to search): force one final
	// answer with the tools removed so it must synthesize. Routed through the
	// backend so a server backend streams it live and a browser relay has the
	// browser stream it from localhost.
	emitPhase("answering")
	_, _, err := mb.Call(ctx, model, messages, nil)
	return err
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
func streamOllamaChatWithTools(ctx context.Context, target string, req *chatRequest, emit func(string)) (oaiMessage, agentUsage, error) {
	req.Stream = true
	payload, err := json.Marshal(req)
	if err != nil {
		return oaiMessage{}, agentUsage{}, err
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader(payload))
	if err != nil {
		return oaiMessage{}, agentUsage{}, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Host = "localhost:11434"
	httpReq.Header.Del("Origin")
	httpReq.Header.Del("Referer")
	resp, err := http.DefaultClient.Do(httpReq)
	if err != nil {
		return oaiMessage{}, agentUsage{}, fmt.Errorf("model request failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return oaiMessage{}, agentUsage{}, fmt.Errorf("model error: %s", resp.Status)
	}
	var usage agentUsage

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
					Usage *struct {
						PromptTokens     int `json:"prompt_tokens"`
						CompletionTokens int `json:"completion_tokens"`
						TotalTokens      int `json:"total_tokens"`
					} `json:"usage,omitempty"`
				}
				if json.Unmarshal([]byte(data), &chunk) == nil {
					if chunk.Usage != nil {
						usage.PromptTokens = chunk.Usage.PromptTokens
						usage.CompletionTokens = chunk.Usage.CompletionTokens
					}
					if len(chunk.Choices) == 0 {
						continue
					}
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
				return oaiMessage{}, agentUsage{}, fmt.Errorf("connection lost: %w", err)
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
		return msg, agentUsage{}, errors.New("empty response from model")
	}
	return msg, usage, nil
}

// runWebSearch queries SearXNG and returns formatted result snippets plus the
// top hit URLs (title+url) so the UI can show clickable proof a search ran.
// The snippet text is what the model sees; hits are for the user.
func (s *server) runWebSearch(argsJSON string) (string, []searchSource) {
	var args struct {
		Query string `json:"query"`
	}
	if err := json.Unmarshal([]byte(argsJSON), &args); err != nil || strings.TrimSpace(args.Query) == "" {
		return "No search query provided.", nil
	}
	searchURL := strings.TrimRight(s.cfg.searxngURL, "/") + "/search?q=" + url.QueryEscape(args.Query) + "&format=json"
	req, err := http.NewRequest(http.MethodGet, searchURL, nil)
	if err != nil {
		return "Search backend misconfigured.", nil
	}
	resp, err := searxngClient.Do(req)
	if err != nil {
		log.Printf("web_search: %v", err)
		return "Search failed: " + err.Error(), nil
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Sprintf("Search backend returned %s.", resp.Status), nil
	}
	var sr struct {
		Results []struct {
			Title   string `json:"title"`
			URL     string `json:"url"`
			Content string `json:"content"`
		} `json:"results"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&sr); err != nil {
		return "Search returned unreadable results.", nil
	}
	if len(sr.Results) == 0 {
		return "No results found.", nil
	}
	var b strings.Builder
	var hits []searchSource
	for i, r := range sr.Results {
		if i >= searchResultCount {
			break
		}
		snippet := cleanSnippet(r.Content, searchSnippetChars)
		fmt.Fprintf(&b, "[%d] %s\n    %s\n    %s\n\n", i+1, r.Title, r.URL, snippet)
		hits = append(hits, searchSource{Title: r.Title, URL: r.URL, Snippet: snippet})
	}
	return b.String(), hits
}

// cleanSnippet normalizes raw SearXNG content into readable text: collapses
// whitespace runs, strips stray control chars and embedded URLs (links are
// shown separately as mini chips), and trims to a clean boundary within max.
func cleanSnippet(raw string, max int) string {
	s := strings.Map(func(r rune) rune {
		if r == '\n' || r == '\r' || r == '\t' {
			return ' '
		}
		if r < 32 {
			return -1
		}
		return r
	}, raw)
	// Collapse runs of whitespace into a single space.
	s = strings.Join(strings.Fields(s), " ")
	s = strings.TrimSpace(s)
	if len(s) > max {
		s = s[:max]
		// Try to cut at the last sentence/phrase boundary within the trim window.
		if idx := strings.LastIndexAny(s[:max], ".!?,;:—–"); idx > max/2 {
			s = s[:idx+1]
		}
		s = strings.TrimRight(s, " .,!?,;:") + "…"
	}
	return s
}

// handleChatWithSearch serves the legacy /api/chat/completions web_search path,
// emitting OpenAI-format SSE. The tool loop itself lives in runSearchLoop; here
// we only wire it to the ResponseWriter with a keepalive goroutine so the
// Cloudflare 100s edge timeout (524) never fires while the N100 thinks.
func (s *server) handleChatWithSearch(w http.ResponseWriter, r *http.Request, body []byte, chatURL string) {
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

	// The legacy /api/chat/completions web_search path is always server-side
	// (local models go through /generate), so drive the resolved host directly.
	mb := &directOllama{chatURL: chatURL, emit: emit}
	err := s.runSearchLoop(ctx, mb, req.Model, req.Messages, emit, emitPhase, func(searchEntry) {})
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

package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

const (
	// genTimeout bounds a single background generation. The SSE keepalive keeps
	// the browser<->backend leg alive well within Cloudflare's 100s edge timeout;
	// this bounds the backend<->Ollama leg so a stuck generation can't hang a
	// worker slot forever.
	genTimeout     = 5 * time.Minute
	subBufferSize  = 512 // ~50s of tokens at 10 tok/s on the N100; live clients read far faster
	keepaliveEvery = 5 * time.Second
)

// errJobActive means a generation job is already running for a conversation.
var errJobActive = errors.New("a generation is already running for this conversation")

// subEvent is a single event pushed to an SSE subscriber.
type subEvent struct {
	kind string // "chunk", "phase", "search", "done", "error"
	text string
}

// job is an in-flight (or just-finished) background generation. It is the
// source of truth for live subscribers; SQLite holds a durable copy for
// crash reconciliation and inspection. A job is removed from the manager's
// active map once it reaches a terminal state, but subscribers that already
// hold a pointer keep draining until they see the terminal event.
type job struct {
	id        string
	convID    string
	email     string
	model     string
	webSearch bool
	createdAt int64

	mu              sync.Mutex
	status          string // queued, generating, done, error, cancelled
	content         strings.Builder
	errMsg          string
	phase           string         // last phase hint (searching/answering…): replayed on (re)connect
	searches        []searchEntry // accumulated web-search evidence: broadcast + persisted
	subs            map[chan subEvent]struct{}
	finished        chan struct{}      // closed when the job reaches a terminal state
	cancelFn        context.CancelFunc // set when the job starts running
	cancelRequested bool               // set by cancel(): survive a queued/unstarted job
}

func newJobID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("%x", time.Now().UnixNano())
	}
	return hex.EncodeToString(b)
}

func newJob(convID, email, model string, webSearch bool) *job {
	return &job{
		id:        newJobID(),
		convID:    convID,
		email:     email,
		model:     model,
		webSearch: webSearch,
		createdAt: time.Now().UnixMilli(),
		status:    "queued",
		subs:      map[chan subEvent]struct{}{},
		finished:  make(chan struct{}),
	}
}

// emitChunk appends delta to the accumulated content and broadcasts it to every
// subscriber. A slow subscriber's channel is non-blocking: a dropped chunk is
// recovered on the next reconnect via the reset/replay prefix.
func (j *job) emitChunk(delta string) {
	if delta == "" {
		return
	}
	j.mu.Lock()
	j.content.WriteString(delta)
	subs := make([]chan subEvent, 0, len(j.subs))
	for ch := range j.subs {
		subs = append(subs, ch)
	}
	j.mu.Unlock()
	ev := subEvent{kind: "chunk", text: delta}
	for _, ch := range subs {
		select {
		case ch <- ev:
		default:
		}
	}
}

// emitPhase broadcasts a phase hint (e.g. "searching", "answering") so the UI
// can show an appropriate waiting state. The latest phase is also stored so a
// client that connects after the hint fired (a common race: runSearchLoop emits
// "searching" before the SSE stream opens) gets it replayed on subscribe.
func (j *job) emitPhase(phase string) {
	j.mu.Lock()
	j.phase = phase
	subs := make([]chan subEvent, 0, len(j.subs))
	for ch := range j.subs {
		subs = append(subs, ch)
	}
	j.mu.Unlock()
	ev := subEvent{kind: "phase", text: phase}
	for _, ch := range subs {
		select {
		case ch <- ev:
		default:
		}
	}
}

// emitSearch records a web-search event (a real query + its sources, or a
// Skipped marker) and broadcasts it to every subscriber so the UI can show
// proof a lookup ran. Also accumulated for persistence and SSE replay.
func (j *job) emitSearch(entry searchEntry) {
	j.mu.Lock()
	j.searches = append(j.searches, entry)
	subs := make([]chan subEvent, 0, len(j.subs))
	for ch := range j.subs {
		subs = append(subs, ch)
	}
	j.mu.Unlock()
	b, _ := json.Marshal(entry)
	ev := subEvent{kind: "search", text: string(b)}
	for _, ch := range subs {
		select {
		case ch <- ev:
		default:
		}
	}
}

// searchSnapshot returns a copy of the accumulated web-search evidence for
// persistence (attached to the saved assistant message) and SSE replay.
func (j *job) searchSnapshot() []searchEntry {
	j.mu.Lock()
	defer j.mu.Unlock()
	if len(j.searches) == 0 {
		return nil
	}
	out := make([]searchEntry, len(j.searches))
	copy(out, j.searches)
	return out
}

func (j *job) contentString() string {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.content.String()
}

// phaseSnapshot returns the latest phase hint for SSE replay on (re)connect.
func (j *job) phaseSnapshot() string {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.phase
}

// cancel requests a stop. It records the request even before the job starts
// (queued) so the worker drops it without driving Ollama, and calls the job's
// context cancel if it is already running.
func (j *job) cancel() {
	j.mu.Lock()
	j.cancelRequested = true
	c := j.cancelFn
	j.mu.Unlock()
	if c != nil {
		c()
	}
}

func (j *job) snapshot() (status, content, errMsg string) {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.status, j.content.String(), j.errMsg
}

// subscribe registers a subscriber and returns its event channel plus the
// content accumulated so far (the replay prefix the SSE handler sends as a
// "reset" event so reconnects don't double-count).
func (j *job) subscribe() (chan subEvent, string) {
	ch := make(chan subEvent, subBufferSize)
	j.mu.Lock()
	j.subs[ch] = struct{}{}
	prefix := j.content.String()
	j.mu.Unlock()
	return ch, prefix
}

func (j *job) unsubscribe(ch chan subEvent) {
	j.mu.Lock()
	delete(j.subs, ch)
	j.mu.Unlock()
}

// notifyDone marks the job done and broadcasts the terminal event. The worker
// calls this AFTER persisting the assistant message, so a subscriber that
// reacts to "done" and reloads the conversation will see the finished reply.
func (j *job) notifyDone() {
	j.mu.Lock()
	if j.status == "done" || j.status == "error" {
		j.mu.Unlock()
		return
	}
	j.status = "done"
	subs := make([]chan subEvent, 0, len(j.subs))
	for ch := range j.subs {
		subs = append(subs, ch)
	}
	close(j.finished)
	j.mu.Unlock()
	for _, ch := range subs {
		select {
		case ch <- subEvent{kind: "done"}:
		default:
		}
	}
}

// notifyCancelled marks the job cancelled and broadcasts a terminal "done".
// Subscribers treat it like a normal finish (they reload the conversation,
// which now holds the partial assistant reply).
func (j *job) notifyCancelled() {
	j.mu.Lock()
	if j.status == "done" || j.status == "error" || j.status == "cancelled" {
		j.mu.Unlock()
		return
	}
	j.status = "cancelled"
	subs := make([]chan subEvent, 0, len(j.subs))
	for ch := range j.subs {
		subs = append(subs, ch)
	}
	close(j.finished)
	j.mu.Unlock()
	for _, ch := range subs {
		select {
		case ch <- subEvent{kind: "done"}:
		default:
		}
	}
}

// notifyError marks the job errored and broadcasts the terminal event.
func (j *job) notifyError(msg string) {
	j.mu.Lock()
	if j.status == "done" || j.status == "error" {
		j.mu.Unlock()
		return
	}
	j.status = "error"
	j.errMsg = msg
	subs := make([]chan subEvent, 0, len(j.subs))
	for ch := range j.subs {
		subs = append(subs, ch)
	}
	close(j.finished)
	j.mu.Unlock()
	for _, ch := range subs {
		select {
		case ch <- subEvent{kind: "error", text: msg}:
		default:
		}
	}
}

// --- Job manager ---

type jobManager struct {
	mu     sync.Mutex
	active map[string]*job // keyed by conversation ID
	queue  chan *job
	store  *store
	srv    *server
}

func newJobManager(store *store, srv *server) *jobManager {
	jm := &jobManager{
		active: map[string]*job{},
		queue:  make(chan *job, 64),
		store:  store,
		srv:    srv,
	}
	go jm.worker()
	return jm
}

func (jm *jobManager) enqueue(j *job) error {
	jm.mu.Lock()
	if _, ok := jm.active[j.convID]; ok {
		jm.mu.Unlock()
		return errJobActive
	}
	jm.active[j.convID] = j
	jm.mu.Unlock()
	if err := jm.store.createJob(j); err != nil {
		jm.mu.Lock()
		delete(jm.active, j.convID)
		jm.mu.Unlock()
		return err
	}
	jm.queue <- j
	return nil
}

func (jm *jobManager) get(convID string) *job {
	jm.mu.Lock()
	defer jm.mu.Unlock()
	return jm.active[convID]
}

// cancel requests a stop for the conversation's active job. Returns false if
// there is no active job for this conversation/user (so the handler can 404).
// A queued job is dropped before it starts; a running job has its Ollama
// request aborted via the job's context. Either way the worker finalizes the
// job as cancelled (partial content persisted).
func (jm *jobManager) cancel(convID, email string) bool {
	jm.mu.Lock()
	j, ok := jm.active[convID]
	jm.mu.Unlock()
	if !ok || j.email != email {
		return false
	}
	j.cancel()
	return true
}

func (jm *jobManager) activeByUser(email string) map[string]string {
	jm.mu.Lock()
	defer jm.mu.Unlock()
	out := map[string]string{}
	for cid, j := range jm.active {
		if j.email == email {
			st, _, _ := j.snapshot()
			out[cid] = st
		}
	}
	return out
}

// worker is the single generation slot, matching OLLAMA_NUM_PARALLEL=1: jobs
// run one at a time; others wait queued. It drives Ollama on
// context.Background() (plus a timeout) so a browser disconnect never cancels
// generation. After the assistant message is persisted, it notifies
// subscribers.
func (jm *jobManager) worker() {
	for j := range jm.queue {
		j.mu.Lock()
		if j.cancelRequested {
			// Stopped while still queued: never start Ollama.
			j.mu.Unlock()
			_ = jm.store.finalizeJob(j.id, "cancelled", "", time.Now().UnixMilli())
			j.notifyCancelled()
			jm.mu.Lock()
			delete(jm.active, j.convID)
			jm.mu.Unlock()
			continue
		}
		j.status = "generating"
		j.mu.Unlock()
		_ = jm.store.setJobGenerating(j.id)

		err := jm.srv.runGeneration(j)
		content := j.contentString()
		var smeta *searchMeta
		if searches := j.searchSnapshot(); len(searches) > 0 {
			smeta = &searchMeta{Searches: searches}
		}

		j.mu.Lock()
		cancelled := j.cancelRequested // set by cancel() before it fires the context
		j.mu.Unlock()

		switch {
		case cancelled:
			// Stopped by the user: persist the partial reply (if any) and report
			// a clean "done" to subscribers rather than an error.
			ts := time.Now().UnixMilli()
			if strings.TrimSpace(content) != "" {
				_ = jm.store.setJobContent(j.id, content)
				_ = jm.store.appendAssistantMessage(j.email, j.convID, Message{Role: "assistant", Content: content, Ts: ts, Search: smeta})
			}
			_ = jm.store.finalizeJob(j.id, "cancelled", "", ts)
			j.notifyCancelled()
		case err != nil:
			_ = jm.store.finalizeJob(j.id, "error", err.Error(), time.Now().UnixMilli())
			j.notifyError(err.Error())
		default:
			_ = jm.store.setJobContent(j.id, content)
			ts := time.Now().UnixMilli()
			_ = jm.store.appendAssistantMessage(j.email, j.convID, Message{Role: "assistant", Content: content, Ts: ts, Search: smeta})
			_ = jm.store.finalizeJob(j.id, "done", "", ts)
			j.notifyDone()
		}

		jm.mu.Lock()
		delete(jm.active, j.convID)
		jm.mu.Unlock()
	}
}

// --- Generation (drives Ollama detached from any HTTP request) ---

// messageContent builds the OpenAI `content` field for a stored Message.
// Text-only messages stay a plain JSON string (what non-vision models expect);
// a message carrying Images becomes an array of typed parts —
// [{type:"text",text:…},{type:"image_url",image_url:{url:…}}] — so a vision
// model such as gemma3:4b actually receives the image. Images are stored as
// data URLs and passed through verbatim.
func messageContent(m Message) json.RawMessage {
	if len(m.Images) == 0 {
		return jsonString(m.Content)
	}
	type imageURL struct {
		URL string `json:"url"`
	}
	type part struct {
		Type     string    `json:"type"`
		Text     string    `json:"text,omitempty"`
		ImageURL *imageURL `json:"image_url,omitempty"`
	}
	parts := make([]part, 0, 1+len(m.Images))
	if m.Content != "" {
		parts = append(parts, part{Type: "text", Text: m.Content})
	}
	for _, img := range m.Images {
		parts = append(parts, part{Type: "image_url", ImageURL: &imageURL{URL: img}})
	}
	b, _ := json.Marshal(parts)
	return json.RawMessage(b)
}

// runGeneration loads the conversation, builds the message list, and drives
// Ollama on a background context. Content deltas flow through the job's
// broadcast. Returns nil on a clean finish, an error otherwise.
func (s *server) runGeneration(j *job) error {
	ctx, cancel := context.WithTimeout(context.Background(), genTimeout)
	defer cancel()
	j.mu.Lock()
	j.cancelFn = cancel // let handleCancel abort the in-flight Ollama request
	j.mu.Unlock()

	conv, err := s.store.getConversation(j.email, j.convID)
	if err != nil {
		return fmt.Errorf("load conversation: %w", err)
	}
	if conv == nil {
		return errors.New("conversation not found")
	}

	msgs := make([]oaiMessage, len(conv.Messages))
	for i, m := range conv.Messages {
		msgs[i] = oaiMessage{Role: m.Role, Content: messageContent(m)}
	}

	if j.webSearch {
		if s.cfg.searxngURL == "" {
			// Toggle was on but no SearXNG backend configured: surface it instead
			// of silently answering as if search were off.
			j.emitSearch(searchEntry{Skipped: true, Reason: "web search not configured"})
			return s.runStreamPass(ctx, j.model, msgs, j.emitChunk)
		}
		return s.runSearchLoop(ctx, j.model, msgs, j.emitChunk, j.emitPhase, j.emitSearch)
	}
	return s.runStreamPass(ctx, j.model, msgs, j.emitChunk)
}

// runStreamPass streams a plain (no-tools) completion from Ollama, emitting
// content deltas. Returns nil on a clean finish, an error otherwise.
func (s *server) runStreamPass(ctx context.Context, model string, msgs []oaiMessage, emit func(string)) error {
	req := chatRequest{Model: model, Messages: msgs}
	target := strings.TrimRight(s.cfg.ollamaURL, "/") + "/v1/chat/completions"
	return s.streamFromOllama(ctx, target, &req, emit)
}

// streamFromOllama POSTs a streaming chat completion and pipes parsed content
// deltas to emit. Returns nil on [DONE] or EOF-with-content, an error
// otherwise. Host is forced to localhost:11434 and Origin/Referer stripped,
// mirroring the Caddy reverse proxy (Ollama 403s non-localhost Hosts and any
// request carrying an Origin).
func (s *server) streamFromOllama(ctx context.Context, target string, req *chatRequest, emit func(string)) error {
	req.Stream = true
	payload, err := json.Marshal(req)
	if err != nil {
		return err
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Host = "localhost:11434"
	httpReq.Header.Del("Origin")
	httpReq.Header.Del("Referer")
	resp, err := http.DefaultClient.Do(httpReq)
	if err != nil {
		return fmt.Errorf("model request failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("model error: %s", resp.Status)
	}
	br := bufio.NewReader(resp.Body)
	got := false
	for {
		line, err := br.ReadBytes('\n')
		if len(line) > 0 {
			t := strings.TrimSpace(string(line))
			if strings.HasPrefix(t, "data: ") {
				data := t[6:]
				if data == "[DONE]" {
					if !got {
						return errors.New("empty response from model")
					}
					return nil
				}
				var o struct {
					Choices []struct {
						Delta struct {
							Content string `json:"content"`
						} `json:"delta"`
					} `json:"choices"`
				}
				if json.Unmarshal([]byte(data), &o) == nil && len(o.Choices) > 0 {
					if c := o.Choices[0].Delta.Content; c != "" {
						got = true
						emit(c)
					}
				}
			}
		}
		if err != nil {
			if got {
				return nil // connection ended after content; treat as success
			}
			if err == io.EOF {
				return errors.New("empty response from model")
			}
			return fmt.Errorf("connection lost: %w", err)
		}
	}
}

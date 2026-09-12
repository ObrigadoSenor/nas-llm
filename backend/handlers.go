package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"sync"
	"time"
)

func jsonError(w http.ResponseWriter, msg string, code int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func emailFrom(r *http.Request) string {
	if v, ok := r.Context().Value(ctxEmail).(string); ok {
		return v
	}
	return ""
}

func validEmail(s string) bool {
	at := strings.IndexByte(s, '@')
	if at <= 0 || at == len(s)-1 {
		return false
	}
	return strings.IndexByte(s[at+1:], '.') >= 0 && len(s) <= 320
}

// --- Auth ---

func (s *server) handleAuthRequest(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Email string `json:"email"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, "invalid request", http.StatusBadRequest)
		return
	}
	email := strings.TrimSpace(strings.ToLower(body.Email))
	if !validEmail(email) {
		jsonError(w, "invalid email", http.StatusBadRequest)
		return
	}
	ip := r.RemoteAddr
	if h := r.Header.Get("X-Forwarded-For"); h != "" {
		ip = strings.TrimSpace(strings.Split(h, ",")[0])
	}
	if !s.limiter.allow("email:"+email, 3, 10*time.Minute) ||
		!s.limiter.allow("ip:"+ip, 5, 10*time.Minute) {
		jsonError(w, "too many requests, try again later", http.StatusTooManyRequests)
		return
	}
	// Allowlist: silently succeed without sending to avoid email enumeration.
	if len(s.cfg.allowedEmails) > 0 && !s.cfg.allowedEmails[email] {
		writeJSON(w, map[string]string{"status": "sent"})
		return
	}
	if err := s.store.upsertUser(email); err != nil {
		log.Printf("upsertUser: %v", err)
		jsonError(w, "server error", http.StatusInternalServerError)
		return
	}
	raw, hash, err := newMagicToken()
	if err != nil {
		log.Printf("newMagicToken: %v", err)
		jsonError(w, "server error", http.StatusInternalServerError)
		return
	}
	if err := s.store.addMagicToken(email, hash, time.Now().Add(magicTokenTTL).UnixMilli()); err != nil {
		log.Printf("addMagicToken: %v", err)
		jsonError(w, "server error", http.StatusInternalServerError)
		return
	}
	link := s.cfg.appBaseURL + "/api/auth/verify?token=" + raw
	if err := s.mailer.sendMagicLink(email, link); err != nil {
		log.Printf("sendMagicLink: %v", err)
		jsonError(w, "could not send email", http.StatusBadGateway)
		return
	}
	writeJSON(w, map[string]string{"status": "sent"})
}

func (s *server) handleAuthVerify(w http.ResponseWriter, r *http.Request) {
	token := r.URL.Query().Get("token")
	if token == "" {
		http.Error(w, "missing token", http.StatusBadRequest)
		return
	}
	email, err := s.store.verifyMagicToken(hashToken(token))
	if err != nil {
		log.Printf("verifyMagicToken: %v", err)
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	if email == "" {
		http.Error(w, "link invalid or expired", http.StatusBadRequest)
		return
	}
	s.setSession(w, email)
	http.Redirect(w, r, s.cfg.appBaseURL+"/", http.StatusSeeOther)
}

func (s *server) handleAuthMe(w http.ResponseWriter, r *http.Request) {
	email, ok := s.sessionEmail(r)
	if !ok {
		jsonError(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	writeJSON(w, map[string]string{"email": email})
}

func (s *server) handleAuthLogout(w http.ResponseWriter, r *http.Request) {
	s.clearSession(w)
	writeJSON(w, map[string]string{"status": "ok"})
}

// --- History ---

func (s *server) handleListConversations(w http.ResponseWriter, r *http.Request) {
	list, err := s.store.listConversations(emailFrom(r))
	if err != nil {
		log.Printf("listConversations: %v", err)
		jsonError(w, "server error", http.StatusInternalServerError)
		return
	}
	if list == nil {
		list = []Conversation{}
	}
	writeJSON(w, list)
}

func (s *server) handleGetConversation(w http.ResponseWriter, r *http.Request) {
	c, err := s.store.getConversation(emailFrom(r), r.PathValue("id"))
	if err != nil {
		log.Printf("getConversation: %v", err)
		jsonError(w, "server error", http.StatusInternalServerError)
		return
	}
	if c == nil {
		jsonError(w, "not found", http.StatusNotFound)
		return
	}
	writeJSON(w, c)
}

func (s *server) handleCreateConversation(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Title    string    `json:"title"`
		Model    string    `json:"model"`
		Messages []Message `json:"messages"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, "invalid request", http.StatusBadRequest)
		return
	}
	if body.Title == "" {
		body.Title = "New chat"
	}
	c, err := s.store.createConversation(emailFrom(r), s.store.newConversationID(), body.Title, body.Model, body.Messages)
	if err != nil {
		log.Printf("createConversation: %v", err)
		jsonError(w, "server error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, c)
}

func (s *server) handleUpdateConversation(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Title    string    `json:"title"`
		Model    string    `json:"model"`
		Messages []Message `json:"messages"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, "invalid request", http.StatusBadRequest)
		return
	}
	c, err := s.store.updateConversation(emailFrom(r), r.PathValue("id"), body.Title, body.Model, body.Messages)
	if err != nil {
		log.Printf("updateConversation: %v", err)
		jsonError(w, "server error", http.StatusInternalServerError)
		return
	}
	if c == nil {
		jsonError(w, "not found", http.StatusNotFound)
		return
	}
	writeJSON(w, c)
}

func (s *server) handleDeleteConversation(w http.ResponseWriter, r *http.Request) {
	ok, err := s.store.deleteConversation(emailFrom(r), r.PathValue("id"))
	if err != nil {
		log.Printf("deleteConversation: %v", err)
		jsonError(w, "server error", http.StatusInternalServerError)
		return
	}
	if !ok {
		jsonError(w, "not found", http.StatusNotFound)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- Folders ---

func (s *server) handleListFolders(w http.ResponseWriter, r *http.Request) {
	list, err := s.store.listFolders(emailFrom(r))
	if err != nil {
		log.Printf("listFolders: %v", err)
		jsonError(w, "server error", http.StatusInternalServerError)
		return
	}
	if list == nil {
		list = []Folder{}
	}
	writeJSON(w, list)
}

func (s *server) handleCreateFolder(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, "invalid request", http.StatusBadRequest)
		return
	}
	name := strings.TrimSpace(body.Name)
	if name == "" {
		jsonError(w, "name is required", http.StatusBadRequest)
		return
	}
	f, err := s.store.createFolder(emailFrom(r), name)
	if err != nil {
		log.Printf("createFolder: %v", err)
		jsonError(w, "server error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, f)
}

func (s *server) handleRenameFolder(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, "invalid request", http.StatusBadRequest)
		return
	}
	name := strings.TrimSpace(body.Name)
	if name == "" {
		jsonError(w, "name is required", http.StatusBadRequest)
		return
	}
	f, err := s.store.renameFolder(emailFrom(r), r.PathValue("id"), name)
	if err != nil {
		log.Printf("renameFolder: %v", err)
		jsonError(w, "server error", http.StatusInternalServerError)
		return
	}
	if f == nil {
		jsonError(w, "not found", http.StatusNotFound)
		return
	}
	writeJSON(w, f)
}

func (s *server) handleDeleteFolder(w http.ResponseWriter, r *http.Request) {
	ok, err := s.store.deleteFolder(emailFrom(r), r.PathValue("id"))
	if err != nil {
		log.Printf("deleteFolder: %v", err)
		jsonError(w, "server error", http.StatusInternalServerError)
		return
	}
	if !ok {
		jsonError(w, "not found", http.StatusNotFound)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- Conversation partial update ---

func (s *server) handlePatchConversation(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Title       *string `json:"title"`
		FolderID    *string `json:"folderId"`
		Model       *string `json:"model"`
		AgentSystem *string `json:"agentSystem"`
		AgentTools  *string `json:"agentTools"`
		RepoID      *string `json:"repoId"`
		RepoBranch  *string `json:"repoBranch"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, "invalid request", http.StatusBadRequest)
		return
	}
	if body.Title == nil && body.FolderID == nil && body.Model == nil && body.AgentSystem == nil && body.AgentTools == nil && body.RepoID == nil && body.RepoBranch == nil {
		jsonError(w, "nothing to update", http.StatusBadRequest)
		return
	}
	c, err := s.store.patchConversation(emailFrom(r), r.PathValue("id"), body.Title, body.FolderID, body.Model, body.AgentSystem, body.AgentTools, body.RepoID, body.RepoBranch)
	if err != nil {
		log.Printf("patchConversation: %v", err)
		jsonError(w, "server error", http.StatusInternalServerError)
		return
	}
	if c == nil {
		jsonError(w, "not found", http.StatusNotFound)
		return
	}
	writeJSON(w, c)
}

// --- Ollama proxy ---

// buildProxy returns a streaming reverse proxy to rawurl with a fixed outbound
// path. The Host header is forced to localhost:11434 because Ollama 403s any
// non-localhost Host (DNS-rebinding protection); the dial target stays rawurl.
func buildProxy(rawurl, path string) http.Handler {
	u, err := url.Parse(rawurl)
	if err != nil {
		panic(err)
	}
	return &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(u)
			r.Out.URL.Path = path
			r.Out.URL.RawPath = ""
			// Ollama 403s any Host that isn't localhost (DNS-rebinding guard)
			// and any request carrying an Origin/Referer (its own CORS check).
			// The browser sends Origin on same-origin POSTs, so strip both.
			r.Out.Host = "localhost:11434"
			r.Out.Header.Del("Origin")
			r.Out.Header.Del("Referer")
		},
		FlushInterval: -1,
	}
}

// handleModels and the model-management routes live in models.go.

func (s *server) handleChat(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(r.Body)
	if err != nil {
		jsonError(w, "invalid request", http.StatusBadRequest)
		return
	}
	r.Body.Close()

	// Branch on the optional web_search flag. Flag off (or no SearXNG
	// configured) -> a streaming passthrough to the Ollama backend that owns the
	// requested model; otherwise the tool loop runs on that same backend.
	var probe struct {
		Model     string `json:"model"`
		WebSearch bool   `json:"web_search"`
	}
	_ = json.Unmarshal(body, &probe)

	// Resolve the backend host that owns the model. If no online host has it
	// (e.g. it lives on the Mac and the Mac is offline), fall back to the default
	// host so Ollama returns a clean not-found instead of the backend 500ing.
	h := s.hosts.onlineHostForModel(probe.Model)
	if h == nil {
		h = s.hosts.defaultHost()
	}

	if !probe.WebSearch || s.cfg.searxngURL == "" {
		r.Body = io.NopCloser(bytes.NewReader(body))
		r.ContentLength = int64(len(body))
		if p := s.chatProxies[h.name]; p != nil {
			p.ServeHTTP(w, r)
		} else if p := s.chatProxies[s.hosts.defaultHost().name]; p != nil {
			p.ServeHTTP(w, r)
		} else {
			jsonError(w, "no inference backend configured", http.StatusBadGateway)
		}
		return
	}

	s.handleChatWithSearch(w, r, body, h.chatURL())
}

// --- Background generation (chat UI) ---

type jobState struct {
	ID        string        `json:"id"`
	Status    string        `json:"status"`
	Content   string        `json:"content"`
	Error     string        `json:"error,omitempty"`
	WebSearch bool          `json:"webSearch"`
	Clarify   bool          `json:"clarify,omitempty"`
	Agent     bool          `json:"agent,omitempty"`
	CreatedAt int64         `json:"createdAt"`
	Searches  []searchEntry `json:"searches,omitempty"`
	Questions *clarifyMeta  `json:"questions,omitempty"`
	Steps     []agentStep   `json:"steps,omitempty"`
	Thoughts  []string      `json:"thoughts,omitempty"`
}

func jobStateFrom(j *job) jobState {
	st, content, errMsg := j.snapshot()
	cq := j.clarifySnapshot()
	// For a clarifying turn, surface the question text as content (matches what
	// gets persisted) so a /job first paint shows the question, not streamed
	// preamble.
	if cq != nil {
		content = clarifyAsContent(cq)
	}
	return jobState{ID: j.id, Status: st, Content: content, Error: errMsg, WebSearch: j.webSearch, Clarify: cq != nil, Agent: j.agent, CreatedAt: j.createdAt, Searches: j.searchSnapshot(), Questions: cq, Steps: j.stepSnapshot(), Thoughts: j.thoughtSnapshot()}
}

// handleGenerate persists the user's turn and enqueues a detached background
// generation. 409 + the existing job's state if one is already active for the
// conversation, so the client tails it instead of duplicating.
func (s *server) handleGenerate(w http.ResponseWriter, r *http.Request) {
	convID := r.PathValue("id")
	email := emailFrom(r)

	var body struct {
		Model     string    `json:"model"`
		Messages  []Message `json:"messages"`
		WebSearch bool      `json:"web_search"`
		Clarify   bool      `json:"clarify"`
		Agent     bool      `json:"agent"`
		// Local flags this as a browser-relay (local-model) generation: the
		// selected model runs on the visitor's own Ollama (localhost:11434), so
		// the backend emits modelCall events and awaits POST /model-response
		// instead of dialing a server host. Such a job is connection-bound.
		Local bool `json:"local"`
		// supportsTools is the frontend's verdict that the selected model can
		// emit OpenAI tool_calls. The backend trusts it only for local
		// (browser-relay) models; server models are re-checked via /api/show.
		SupportsTools bool `json:"supportsTools"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, "invalid request", http.StatusBadRequest)
		return
	}
	if body.Model == "" {
		jsonError(w, "model is required", http.StatusBadRequest)
		return
	}
	// Agent mode supersedes the web_search/clarify toggles: when on, the general
	// loop runs with its own tool allowlist (which includes web_search + ask_user
	// as registered tools, so they compose within one run instead of being
	// mutually exclusive).
	if body.Agent {
		body.WebSearch = false
		body.Clarify = false
	}

	c, err := s.store.getConversation(email, convID)
	if err != nil {
		log.Printf("getConversation: %v", err)
		jsonError(w, "server error", http.StatusInternalServerError)
		return
	}
	if c == nil {
		jsonError(w, "not found", http.StatusNotFound)
		return
	}

	if err := s.store.updateConversationMessages(email, convID, body.Model, body.Messages); err != nil {
		log.Printf("updateConversationMessages: %v", err)
		jsonError(w, "server error", http.StatusInternalServerError)
		return
	}

	if existing := s.jobs.get(convID); existing != nil {
		w.WriteHeader(http.StatusConflict)
		writeJSON(w, jobStateFrom(existing))
		return
	}

	j := newJob(convID, email, body.Model, body.WebSearch, body.Clarify, body.Agent)
	j.local = body.Local
	j.supportsTools = body.SupportsTools
	if err := s.jobs.enqueue(j); err != nil {
		if errors.Is(err, errJobActive) {
			if existing := s.jobs.get(convID); existing != nil {
				w.WriteHeader(http.StatusConflict)
				writeJSON(w, jobStateFrom(existing))
				return
			}
		}
		log.Printf("enqueue: %v", err)
		jsonError(w, "server error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, jobStateFrom(j))
}

// handleJob reports the conversation's active job + partial content (for first
// paint after a reload/reconnect). 204 when no job is active.
func (s *server) handleJob(w http.ResponseWriter, r *http.Request) {
	j := s.jobs.get(r.PathValue("id"))
	if j == nil || j.email != emailFrom(r) {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	writeJSON(w, jobStateFrom(j))
}

// handleCancel stops the conversation's active background job. 404 if there is
// no in-flight job for this conversation/user; the worker then finalizes it as
// cancelled (partial content persisted) and subscribers see a terminal "done".
func (s *server) handleCancel(w http.ResponseWriter, r *http.Request) {
	if !s.jobs.cancel(r.PathValue("id"), emailFrom(r)) {
		jsonError(w, "no active generation for this conversation", http.StatusNotFound)
		return
	}
	writeJSON(w, map[string]string{"status": "cancelled"})
}

// handleActiveJobs returns {conversationID: status} for the caller's active
// jobs, so the sidebar can show which chats are generating.
func (s *server) handleActiveJobs(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, s.jobs.activeByUser(emailFrom(r)))
}

// handleEvents is the SSE tail for a conversation's active job. It replays the
// accumulated content as a "reset" event (so reconnects re-anchor the client's
// accumulator), then streams live chunks/phases until the job finishes. A 5s
// keepalive comment keeps Cloudflare's 100s edge timeout from firing while the
// N100 thinks. With no active job it emits a terminal "done" so the client
// closes cleanly instead of reconnecting.
func (s *server) handleEvents(w http.ResponseWriter, r *http.Request) {
	j := s.jobs.get(r.PathValue("id"))
	if j == nil || j.email != emailFrom(r) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "event: done\ndata: \n\n")
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
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

	ch, prefix := j.subscribe()
	defer j.unsubscribe(ch)

	var mu sync.Mutex
	writeSSE := func(str string) {
		mu.Lock()
		_, _ = io.WriteString(w, str)
		if flusher != nil {
			flusher.Flush()
		}
		mu.Unlock()
	}

	// Replay prefix as "reset"; the client sets acc = reset.data, then appends
	// live chunks. This makes reconnects correct (no double-counting).
	pdata, _ := json.Marshal(prefix)
	writeSSE("event: reset\ndata: " + string(pdata) + "\n\n")
	// Replay any web-search evidence accumulated so far as one "searches" event
	// so a reconnect/reload re-paints the query + source links.
	if searches := j.searchSnapshot(); len(searches) > 0 {
		sdata, _ := json.Marshal(searches)
		writeSSE("event: searches\ndata: " + string(sdata) + "\n\n")
	}
	// Replay any clarifying question(s) stashed so far so a reconnect/reload
	// re-paints the clickable option card.
	if cq := j.clarifySnapshot(); cq != nil {
		qdata, _ := json.Marshal(cq)
		writeSSE("event: questions\ndata: " + string(qdata) + "\n\n")
	}
	// Replay the agent tool-call trace accumulated so far as one "steps" event
	// so a reconnect/reload re-paints the steps drawer.
	if steps := j.stepSnapshot(); len(steps) > 0 {
		stdata, _ := json.Marshal(steps)
		writeSSE("event: steps\ndata: " + string(stdata) + "\n\n")
	}
	// Replay the agent per-round reasoning accumulated so far as one "thoughts"
	// event so a reconnect/reload re-paints the (collapsed) thinking drawer.
	if thoughts := j.thoughtSnapshot(); len(thoughts) > 0 {
		thdata, _ := json.Marshal(thoughts)
		writeSSE("event: thoughts\ndata: " + string(thdata) + "\n\n")
	}
	// Replay the current phase hint. A queued job reports "queued"; a generating
	// web-search job may have already fired "searching" before this stream opened,
	// so replay the stored phase so the UI shows the right waiting state on connect.
	if ph := j.phaseSnapshot(); ph != "" {
		writeSSE("event: phase\ndata: " + ph + "\n\n")
	} else if st, _, _ := j.snapshot(); st == "queued" {
		writeSSE("event: phase\ndata: queued\n\n")
	}
	// Replay a pending local-model inference request last: a browser that
	// attaches after a `modelCall` cue fired (or reconnects mid-round) still
	// needs to run that round on its own Ollama and POST the result back. Placed
	// after the phase/evidence replays so the client re-anchors state first.
	if mc := j.modelCallSnapshot(); mc != nil {
		mcdata, _ := json.Marshal(mc)
		writeSSE("event: modelCall\ndata: " + string(mcdata) + "\n\n")
	}
	// Replay a pending file-tool exec request so a browser that attaches after
	// the toolExec cue fired still runs the tool via the sidecar and POSTs back.
	if te := j.toolExecSnapshot(); te != nil {
		tedata, _ := json.Marshal(te)
		writeSSE("event: toolExec\ndata: " + string(tedata) + "\n\n")
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
				writeSSE(":keep\n\n")
			}
		}
	}()
	defer func() {
		close(stop)
		wg.Wait()
	}()

	flushChunk := func(text string) {
		d, _ := json.Marshal(text)
		writeSSE("event: chunk\ndata: " + string(d) + "\n\n")
	}
	flushPhase := func(text string) {
		writeSSE("event: phase\ndata: " + text + "\n\n")
	}
	flushSearch := func(text string) {
		writeSSE("event: search\ndata: " + text + "\n\n")
	}
	flushQuestions := func(text string) {
		writeSSE("event: questions\ndata: " + text + "\n\n")
	}
	flushTool := func(text string) {
		writeSSE("event: tool\ndata: " + text + "\n\n")
	}
	flushThought := func(text string) {
		writeSSE("event: thought\ndata: " + text + "\n\n")
	}
	flushClear := func() {
		writeSSE("event: clear\ndata: \n\n")
	}
	flushModelCall := func(text string) {
		writeSSE("event: modelCall\ndata: " + text + "\n\n")
	}
	flushToolExec := func(text string) {
		writeSSE("event: toolExec\ndata: " + text + "\n\n")
	}
	flushError := func(text string) {
		d, _ := json.Marshal(text)
		writeSSE("event: joberror\ndata: " + string(d) + "\n\n")
	}

	for {
		select {
		case <-r.Context().Done():
			// A local-model (browser-relay) job is connection-bound: the SSE tail is
			// the only channel the browser uses to receive modelCall cues and POST
			// results, so if it drops (tab closed/navigated) the generation cannot
			// continue. Cancel the job — aborting any pending relay wait — and let
			// the worker persist the partial reply as cancelled. Server-model jobs
			// stay detached and keep generating after a disconnect.
			if j.local {
				j.cancel()
			}
			return
		case ev := <-ch:
			switch ev.kind {
			case "chunk":
				flushChunk(ev.text)
			case "phase":
				flushPhase(ev.text)
			case "search":
				flushSearch(ev.text)
			case "questions":
				flushQuestions(ev.text)
			case "tool":
				flushTool(ev.text)
			case "thought":
				flushThought(ev.text)
			case "modelCall":
				flushModelCall(ev.text)
			case "toolExec":
				flushToolExec(ev.text)
			case "clear":
				flushClear()
			case "done":
				writeSSE("event: done\ndata: \n\n")
				return
			case "error":
				flushError(ev.text)
				return
			}
		case <-j.finished:
			// Backstop for a dropped terminal event: drain buffered events, then
			// synthesize a terminal from the job's final status.
			draining := true
			for draining {
				select {
				case ev := <-ch:
					switch ev.kind {
					case "chunk":
						flushChunk(ev.text)
					case "phase":
						flushPhase(ev.text)
					case "search":
						flushSearch(ev.text)
					case "questions":
						flushQuestions(ev.text)
					case "tool":
						flushTool(ev.text)
					case "thought":
						flushThought(ev.text)
					case "modelCall":
						flushModelCall(ev.text)
					case "toolExec":
						flushToolExec(ev.text)
					case "clear":
						flushClear()
					case "done":
						writeSSE("event: done\ndata: \n\n")
						return
					case "error":
						flushError(ev.text)
						return
					}
				default:
					draining = false
				}
			}
			st, _, msg := j.snapshot()
			if st == "error" {
				flushError(msg)
			} else {
				writeSSE("event: done\ndata: \n\n")
			}
			return
		}
	}
}

// handleModelResponse receives the browser's assembled inference result for one
// local-model (browser-relay) generation round. The browser dials its own
// Ollama at localhost:11434 when it sees a `modelCall` SSE event, streams the
// output into the answer bubble directly, then POSTs the assembled content and
// any tool_calls here. On a failed localhost fetch (Ollama 403 / connection
// refused) it POSTs {error:"..."} instead, which is delivered to the awaiting
// loop as an error so the worker finalizes the job as "error" (no empty
// assistant message persisted). This handler correlates the POST to the pending
// browserRelay.Call via the job's pending-response channel: the first POST to
// arrive claims and delivers (200); a duplicate/late POST, or one with no
// pending call, gets 409. Session-auth-gated like /generate (same cookie).
func (s *server) handleModelResponse(w http.ResponseWriter, r *http.Request) {
	convID := r.PathValue("id")
	email := emailFrom(r)
	var body struct {
		JobID     string        `json:"jobId"`
		Content   string        `json:"content"`
		ToolCalls []oaiToolCall `json:"tool_calls"`
		Error     string        `json:"error,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, "invalid request", http.StatusBadRequest)
		return
	}
	j := s.jobs.get(convID)
	if j == nil || j.email != email {
		jsonError(w, "no active generation for this conversation", http.StatusNotFound)
		return
	}
	if body.JobID != "" && j.id != body.JobID {
		// A stale POST for an older job on the same conversation (a new
		// generation may have started after the old one finished).
		jsonError(w, "job id does not match the active generation", http.StatusConflict)
		return
	}
	// Claim the pending relay channel atomically: only one POST can deliver a
	// response for this round. A nil channel means no relay round is waiting
	// (the modelCall hasn't fired yet, or the round already completed/timed out).
	j.mu.Lock()
	ch := j.pendingRelay
	if ch != nil {
		j.pendingRelay = nil
	}
	j.mu.Unlock()
	if ch == nil {
		jsonError(w, "no pending model call for this job", http.StatusConflict)
		return
	}
	// The channel is buffered (cap 1) and exclusively claimed, so this send
	// always has room and never blocks. browserRelay.Call reads exactly once.
	// A non-empty Error wins over content/tool_calls: the browser POSTs {error}
	// with no content on a failed localhost fetch, and Call returns it as an
	// error so the worker finalizes the job as "error".
	ch <- relayResponse{content: body.Content, toolCalls: body.ToolCalls, Error: body.Error}
	writeJSON(w, map[string]string{"status": "ok"})
}

// --- Agent config (global defaults) ----------------------------------------

// handleAgentConfigGet returns the global agent system prompt + tool allowlist
// plus the full menu of available tools (so the UI can render checkboxes).
func (s *server) handleAgentConfigGet(w http.ResponseWriter, r *http.Request) {
	tools := parseToolList(s.store.getSetting("agent_tools"))
	if len(tools) == 0 {
		tools = defaultAgentTools()
	}
	writeJSON(w, map[string]any{
		"system":    s.store.getSetting("agent_system"),
		"tools":     tools,
		"available": availableTools(s.cfg.fetchPageEnabled),
	})
}

// handleAgentConfigPut sets the global agent system prompt + tool allowlist.
// An empty tool list clears the override (falls back to built-in defaults).
func (s *server) handleAgentConfigPut(w http.ResponseWriter, r *http.Request) {
	var body struct {
		System string   `json:"system"`
		Tools  []string `json:"tools"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, "invalid request", http.StatusBadRequest)
		return
	}
	// Validate tool names against the menu so a stale client can't enable a
	// removed/renamed tool.
	menu := map[string]bool{}
	for _, t := range availableTools(s.cfg.fetchPageEnabled) {
		menu[t.Name] = true
	}
	var valid []string
	for _, t := range body.Tools {
		t = strings.TrimSpace(t)
		if menu[t] {
			valid = append(valid, t)
		}
	}
	if err := s.store.setSetting("agent_system", body.System); err != nil {
		log.Printf("setSetting agent_system: %v", err)
		jsonError(w, "server error", http.StatusInternalServerError)
		return
	}
	if err := s.store.setSetting("agent_tools", strings.Join(valid, ",")); err != nil {
		log.Printf("setSetting agent_tools: %v", err)
		jsonError(w, "server error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]any{"system": body.System, "tools": valid, "available": availableTools(s.cfg.fetchPageEnabled)})
}

// --- File-tool relay (desktop sidecar → backend) ---

// handleToolResponse receives the browser's assembled file-tool result for one
// local tool-execution round (parallel to handleModelResponse for inference).
// The browser dials the desktop sidecar's /__sidecar/repos/exec when it sees a
// `toolExec` SSE event, then POSTs the observation here. Correlates to the job's
// pendingToolExec channel: the first POST claims and delivers (200); a
// duplicate/late POST, or one with no pending call, gets 409.
func (s *server) handleToolResponse(w http.ResponseWriter, r *http.Request) {
	convID := r.PathValue("id")
	email := emailFrom(r)
	var body struct {
		JobID       string `json:"jobId"`
		Observation string `json:"observation"`
		Preview     string `json:"preview"`
		IsError     bool   `json:"isError"`
		Error       string `json:"error,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, "invalid request", http.StatusBadRequest)
		return
	}
	j := s.jobs.get(convID)
	if j == nil || j.email != email {
		jsonError(w, "no active generation for this conversation", http.StatusNotFound)
		return
	}
	if body.JobID != "" && j.id != body.JobID {
		jsonError(w, "job id does not match the active generation", http.StatusConflict)
		return
	}
	j.mu.Lock()
	ch := j.pendingToolExec
	if ch != nil {
		j.pendingToolExec = nil
	}
	j.mu.Unlock()
	if ch == nil {
		jsonError(w, "no pending tool call for this job", http.StatusConflict)
		return
	}
	ch <- toolExecResponse{Observation: body.Observation, Preview: body.Preview, IsError: body.IsError, Error: body.Error}
	writeJSON(w, map[string]string{"status": "ok"})
}

// --- Repos (codebase registration) ---

// handleRepoUpsert registers or updates a repo's context. The desktop sidecar
// pushes this on clone/open so the agent loop can inject repo context into the
// system prompt for repo-bound conversations.
func (s *server) handleRepoUpsert(w http.ResponseWriter, r *http.Request) {
	email := emailFrom(r)
	var body struct {
		FullName  string   `json:"fullName"`
		LocalPath string   `json:"localPath"`
		Branch    string   `json:"branch"`
		Head      string   `json:"head"`
		Tree      []string `json:"tree"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, "invalid request", http.StatusBadRequest)
		return
	}
	if strings.TrimSpace(body.FullName) == "" {
		jsonError(w, "fullName is required", http.StatusBadRequest)
		return
	}
	repo := &Repo{
		FullName:  body.FullName,
		LocalPath: body.LocalPath,
		Branch:    body.Branch,
		Head:      body.Head,
		Tree:      body.Tree,
	}
	saved, err := s.store.upsertRepo(email, repo)
	if err != nil {
		log.Printf("upsertRepo: %v", err)
		jsonError(w, "server error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, saved)
}

// handleListRepos returns the user's registered repos.
func (s *server) handleListRepos(w http.ResponseWriter, r *http.Request) {
	list, err := s.store.listRepos(emailFrom(r))
	if err != nil {
		log.Printf("listRepos: %v", err)
		jsonError(w, "server error", http.StatusInternalServerError)
		return
	}
	if list == nil {
		list = []Repo{}
	}
	writeJSON(w, list)
}

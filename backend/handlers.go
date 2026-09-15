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
		Title            *string `json:"title"`
		FolderID         *string `json:"folderId"`
		Model            *string `json:"model"`
		AgentSystem      *string `json:"agentSystem"`
		AgentTools       *string `json:"agentTools"`
		RepoID           *string `json:"repoId"`
		RepoBranch       *string `json:"repoBranch"`
		AgentAutoApprove *bool   `json:"agentAutoApprove"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, "invalid request", http.StatusBadRequest)
		return
	}
	if body.Title == nil && body.FolderID == nil && body.Model == nil && body.AgentSystem == nil && body.AgentTools == nil && body.RepoID == nil && body.RepoBranch == nil && body.AgentAutoApprove == nil {
		jsonError(w, "nothing to update", http.StatusBadRequest)
		return
	}
	c, err := s.store.patchConversation(emailFrom(r), r.PathValue("id"), body.Title, body.FolderID, body.Model, body.AgentSystem, body.AgentTools, body.RepoID, body.RepoBranch, body.AgentAutoApprove)
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
	// PausedStep is set when Status == "paused": the step index the run paused
	// at, read from the agent_checkpoints row so /job and /api/jobs/active can
	// surface "paused at step N" and a resume can continue on the remaining budget.
	PausedStep int `json:"pausedStep,omitempty"`
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
	s := jobState{ID: j.id, Status: st, Content: content, Error: errMsg, WebSearch: j.webSearch, Clarify: cq != nil, Agent: j.agent, CreatedAt: j.createdAt, Searches: j.searchSnapshot(), Questions: cq, Steps: j.stepSnapshot(), Thoughts: j.thoughtSnapshot()}
	if st == "paused" {
		j.mu.Lock()
		s.PausedStep = j.pausedStep
		j.mu.Unlock()
	}
	return s
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
	j.hub = s.hub
	// needsBrowser marks a job as connection-bound: local (browser-relay)
	// inference relays through the browser by definition, and a repo-bound or
	// SSH-enabled agent run also relays its local tools through the browser
	// (toolExec) even when the model itself runs server-side. All such jobs get
	// the grace-period cancel in handleEvents/handleUserEvents instead of the
	// "survive any disconnect" behavior a plain server-model job gets.
	j.needsBrowser = body.Local || (body.Agent && s.agentRunNeedsBrowser(email, convID, c.RepoID))
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
// paint after a reload/reconnect). 204 when no job is active — except a paused
// agent run, which has no live job but a checkpoint: surface a synthetic
// "paused" state (with the checkpoint's step) so a reload/chat-switch/backend-
// restart still offers the Resume affordance.
func (s *server) handleJob(w http.ResponseWriter, r *http.Request) {
	convID := r.PathValue("id")
	email := emailFrom(r)
	j := s.jobs.get(convID)
	if j == nil || j.email != email {
		if cp, err := s.store.loadCheckpoint(email, convID); err == nil && cp != nil {
			writeJSON(w, jobState{Status: "paused", Agent: true, PausedStep: cp.Step, CreatedAt: cp.CreatedAt})
			return
		}
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

// handlePause pauses the conversation's active agent run between steps. 404 if
// there is no in-flight agent job (a plain chat/search/clarify run is not
// pausable — there is nothing to resume). The worker checkpoints the
// transcript and finalizes the job "paused"; subscribers see a terminal "done".
func (s *server) handlePause(w http.ResponseWriter, r *http.Request) {
	if !s.jobs.pause(r.PathValue("id"), emailFrom(r)) {
		jsonError(w, "no active agent run to pause", http.StatusNotFound)
		return
	}
	writeJSON(w, map[string]string{"status": "pausing"})
}

// handleResume continues a paused agent run from its checkpoint. An optional
// {note} is appended as a user turn (to both the conversation history and the
// rehydrated transcript) so the user can steer the resumed run. 404 if there is
// no checkpoint to resume; 409 if a job is already active for the conversation.
func (s *server) handleResume(w http.ResponseWriter, r *http.Request) {
	convID := r.PathValue("id")
	email := emailFrom(r)
	cp, err := s.store.loadCheckpoint(email, convID)
	if err != nil {
		log.Printf("loadCheckpoint: %v", err)
		jsonError(w, "server error", http.StatusInternalServerError)
		return
	}
	if cp == nil {
		jsonError(w, "no paused run to resume", http.StatusNotFound)
		return
	}
	var body struct {
		Note string `json:"note"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body) // best-effort; note is optional
	if note := strings.TrimSpace(body.Note); note != "" {
		if c, err := s.store.getConversation(email, convID); err == nil && c != nil {
			msgs := append(c.Messages, Message{Role: "user", Content: note, Ts: time.Now().UnixMilli()})
			_ = s.store.updateConversationMessages(email, convID, cp.Model, msgs)
		}
	}
	if existing := s.jobs.get(convID); existing != nil {
		w.WriteHeader(http.StatusConflict)
		writeJSON(w, jobStateFrom(existing))
		return
	}
	j := newJob(convID, email, cp.Model, false, false, true) // agent=true, resume
	j.local = cp.Local
	j.supportsTools = cp.SupportsTools
	j.hub = s.hub
	j.resuming = true
	j.resumeNote = body.Note
	c, _ := s.store.getConversation(email, convID)
	repoID := ""
	if c != nil {
		repoID = c.RepoID
	}
	j.needsBrowser = cp.Local || s.agentRunNeedsBrowser(email, convID, repoID)
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
	// Replay a pending toolStart so a browser that attaches mid-execution reopens
	// the running command block (spinner) on reconnect, instead of seeing nothing
	// until the result lands.
	if ts := j.toolStartSnapshot(); ts != nil {
		tsdata, _ := json.Marshal(ts)
		writeSSE("event: toolStart\ndata: " + string(tsdata) + "\n\n")
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
	flushToolStart := func(text string) {
		writeSSE("event: toolStart\ndata: " + text + "\n\n")
	}
	flushError := func(text string) {
		d, _ := json.Marshal(text)
		writeSSE("event: joberror\ndata: " + string(d) + "\n\n")
	}

	for {
		select {
		case <-r.Context().Done():
			// A job that needs the browser (local inference, or a repo-bound agent
			// run relaying file tools) is connection-bound: this tail is one of the
			// two channels (the other being the user's /api/events stream) the
			// browser uses to receive modelCall/toolExec cues and POST results back.
			// Rather than cancelling outright, give it BROWSER_RELAY_GRACE to
			// reattach via either channel — this is what lets a chat switch or a
			// page reload survive instead of killing the generation, while an
			// actually-closed app still gets cleaned up. Jobs that don't need the
			// browser stay detached and keep generating after a disconnect, exactly
			// as before.
			if j.needsBrowser {
				j.scheduleGraceCancel(s.cfg.browserRelayGrace, s.hub)
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
			case "toolStart":
				flushToolStart(ev.text)
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
					case "toolStart":
						flushToolStart(ev.text)
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

// handleUserEvents is GET /api/events: a per-user multiplexed SSE stream
// carrying modelCall/toolExec/phase/done/joberror events for every job the
// caller has running, each tagged with convId+jobId so the client can route it
// to the right chat. This is what lets a backgrounded chat's browser relay
// keep working and the sidebar/notification UI stay current without a
// dedicated per-conversation tail per chat — the desktop sidecar's HTTP/1.1
// 127.0.0.1 origin and the webview's ~6-connections-per-origin cap mean only
// two long-lived connections (this one plus the single foreground tail) can be
// afforded regardless of how many chats are actually running. With no
// user-specific state to replay (unlike a job's per-conversation tail), this
// only streams events live plus the same keepalive discipline as handleEvents.
func (s *server) handleUserEvents(w http.ResponseWriter, r *http.Request) {
	email := emailFrom(r)

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

	ch := s.hub.subscribe(email)
	defer s.hub.unsubscribe(email, ch)

	var mu sync.Mutex
	writeSSE := func(str string) {
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
				writeSSE(":keep\n\n")
			}
		}
	}()
	defer func() {
		close(stop)
		wg.Wait()
	}()

	for {
		select {
		case <-r.Context().Done():
			// This stream dropped (chat backgrounded/tab closed/app closed). Any of
			// this user's browser-bound jobs gets a grace period to reattach — via
			// this stream again or its own per-conversation tail — before being
			// cancelled; see job.scheduleGraceCancel. A job whose per-conversation
			// tail is still open is scheduled too, harmlessly: its check finds that
			// tail live and does nothing.
			s.jobs.scheduleGraceForUser(email, s.cfg.browserRelayGrace, s.hub)
			return
		case ev := <-ch:
			// "error" is the internal kind; the wire event name is "joberror" per
			// contract 1, matching handleEvents' flushError.
			name := ev.kind
			if name == "error" {
				name = "joberror"
			}
			writeSSE("event: " + name + "\ndata: " + ev.text + "\n\n")
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
	email := emailFrom(r)
	tools := parseToolList(s.store.getSetting("agent_tools"))
	if len(tools) == 0 {
		tools = defaultAgentTools()
	}
	sshHosts, _ := s.store.listSSHHosts(email)
	writeJSON(w, map[string]any{
		"system":      s.store.getSetting("agent_system"),
		"tools":       tools,
		"available":   availableTools(s.cfg.fetchPageEnabled, sshHostAliases(sshHosts)),
		"autoApprove": s.store.getSetting("agent_auto_approve") != "0", // default ON
		"sshHosts":    sshHosts,
	})
}

// handleAgentConfigPut sets the global agent system prompt + tool allowlist.
// An empty tool list clears the override (falls back to built-in defaults).
func (s *server) handleAgentConfigPut(w http.ResponseWriter, r *http.Request) {
	email := emailFrom(r)
	var body struct {
		System      string   `json:"system"`
		Tools       []string `json:"tools"`
		AutoApprove *bool    `json:"autoApprove"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, "invalid request", http.StatusBadRequest)
		return
	}
	// Validate tool names against the menu so a stale client can't enable a
	// removed/renamed tool.
	sshHosts, _ := s.store.listSSHHosts(email)
	menu := map[string]bool{}
	for _, t := range availableTools(s.cfg.fetchPageEnabled, sshHostAliases(sshHosts)) {
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
	if body.AutoApprove != nil {
		v := "0"
		if *body.AutoApprove {
			v = "1"
		}
		if err := s.store.setSetting("agent_auto_approve", v); err != nil {
			log.Printf("setSetting agent_auto_approve: %v", err)
			jsonError(w, "server error", http.StatusInternalServerError)
			return
		}
	}
	writeJSON(w, map[string]any{"system": body.System, "tools": valid, "available": availableTools(s.cfg.fetchPageEnabled, sshHostAliases(sshHosts)), "autoApprove": s.store.getSetting("agent_auto_approve") != "0"})
}

// agentRunNeedsBrowser reports whether an agent run will relay local tools
// through the browser and so is connection-bound: a repo-bound run (whose
// localRepoTools are auto-appended) or a run whose effective allowlist contains
// an ssh_* tool while the user has ≥1 configured SSH host. Used at job creation
// (handleGenerate/handleResume) so the grace-period cancel only applies to runs
// that actually need the browser; a server-model agent run with no local tools
// stays detached and survives a disconnect.
func (s *server) agentRunNeedsBrowser(email, convID, repoID string) bool {
	if repoID != "" {
		return true
	}
	hosts, _ := s.store.listSSHHosts(email)
	return len(hosts) > 0 && containsAnySSHTool(s.agentAllowlist(email, convID))
}

// --- SSH hosts (allowlist for the agent's ssh_* tools) ---------------------

// handleAgentSSHHostsList returns the caller's allowlisted SSH aliases.
func (s *server) handleAgentSSHHostsList(w http.ResponseWriter, r *http.Request) {
	hosts, err := s.store.listSSHHosts(emailFrom(r))
	if err != nil {
		log.Printf("listSSHHosts: %v", err)
		jsonError(w, "server error", http.StatusInternalServerError)
		return
	}
	if hosts == nil {
		hosts = []SSHHost{}
	}
	writeJSON(w, hosts)
}

// handleAgentSSHHostUpsert adds or updates an SSH alias in the caller's
// allowlist. The alias must be a safe bare token (matching a ~/.ssh/config Host
// nickname); no credentials are stored — the desktop resolves the alias via its
// own ssh config.
func (s *server) handleAgentSSHHostUpsert(w http.ResponseWriter, r *http.Request) {
	email := emailFrom(r)
	var body struct {
		Alias       string `json:"alias"`
		Description string `json:"description"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, "invalid request", http.StatusBadRequest)
		return
	}
	alias := strings.TrimSpace(body.Alias)
	if alias == "" {
		jsonError(w, "alias is required", http.StatusBadRequest)
		return
	}
	if !isSSHAlias(alias) {
		jsonError(w, "alias must be a simple token (letters, digits, dot, dash, underscore)", http.StatusBadRequest)
		return
	}
	host, err := s.store.upsertSSHHost(email, alias, strings.TrimSpace(body.Description))
	if err != nil {
		log.Printf("upsertSSHHost: %v", err)
		jsonError(w, "server error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, host)
}

// handleAgentSSHHostDelete removes an SSH alias from the caller's allowlist.
func (s *server) handleAgentSSHHostDelete(w http.ResponseWriter, r *http.Request) {
	alias := r.PathValue("alias")
	if alias == "" {
		jsonError(w, "alias is required", http.StatusBadRequest)
		return
	}
	deleted, err := s.store.deleteSSHHost(emailFrom(r), alias)
	if err != nil {
		log.Printf("deleteSSHHost: %v", err)
		jsonError(w, "server error", http.StatusInternalServerError)
		return
	}
	if !deleted {
		jsonError(w, "no such SSH host", http.StatusNotFound)
		return
	}
	writeJSON(w, map[string]string{"status": "deleted"})
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
		ExitCode    int    `json:"exitCode,omitempty"`
		Output      string `json:"output,omitempty"`
		Cwd         string `json:"cwd,omitempty"`
		Branch      string `json:"branch,omitempty"`
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
	ch <- toolExecResponse{Observation: body.Observation, Preview: body.Preview, IsError: body.IsError, Error: body.Error, ExitCode: body.ExitCode, Output: body.Output, Cwd: body.Cwd, Branch: body.Branch}
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
		Name      string   `json:"name"`
		UseGit    *bool    `json:"useGit"`
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
	// useGit defaults to true when absent so older sidecars (which never send it)
	// keep registering git repos exactly as before.
	useGit := true
	if body.UseGit != nil {
		useGit = *body.UseGit
	}
	name := strings.TrimSpace(body.Name)
	if name == "" {
		name = body.FullName
	}
	repo := &Repo{
		FullName:  body.FullName,
		Name:      name,
		UseGit:    useGit,
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

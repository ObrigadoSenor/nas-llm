package main

import (
	"encoding/json"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
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
		Title    *string `json:"title"`
		FolderID *string `json:"folderId"`
		Model    *string `json:"model"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, "invalid request", http.StatusBadRequest)
		return
	}
	if body.Title == nil && body.FolderID == nil && body.Model == nil {
		jsonError(w, "nothing to update", http.StatusBadRequest)
		return
	}
	c, err := s.store.patchConversation(emailFrom(r), r.PathValue("id"), body.Title, body.FolderID, body.Model)
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

func (s *server) handleModels(w http.ResponseWriter, r *http.Request) {
	s.modelsProxy.ServeHTTP(w, r)
}

func (s *server) handleChat(w http.ResponseWriter, r *http.Request) {
	s.chatProxy.ServeHTTP(w, r)
}

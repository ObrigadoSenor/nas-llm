package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"strings"
	"time"
)

type config struct {
	addr          string
	sessionSecret []byte
	cookieSecure  bool
	brevoKey      string
	appBaseURL    string
	mailFrom      string
	allowedEmails map[string]bool
	dbPath        string
	ollamaURL     string
	searxngURL    string
}

type server struct {
	cfg         config
	store       *store
	limiter     *rateLimiter
	mailer      mailer
	modelsProxy http.Handler
	chatProxy   http.Handler
	jobs        *jobManager
}

type ctxKey int

const ctxEmail ctxKey = 0

func main() {
	cfg := config{
		addr:          ":" + env("BACKEND_PORT", "8081"),
		sessionSecret: []byte(mustEnv("SESSION_SECRET")),
		brevoKey:      env("BREVO_API_KEY", ""),
		appBaseURL:    env("APP_BASE_URL", "https://chat.selected.systems"),
		mailFrom:      env("MAIL_FROM", "noreply@selected.systems"),
		dbPath:        env("DB_PATH", "/data/nas-llm.db"),
		ollamaURL:     env("OLLAMA_URL", "http://ollama:11434"),
		searxngURL:    env("SEARXNG_URL", ""),
	}
	cfg.cookieSecure = strings.HasPrefix(cfg.appBaseURL, "https://")
	cfg.allowedEmails = parseAllowed(os.Getenv("ALLOWED_EMAILS"))

	st, err := newStore(cfg.dbPath)
	if err != nil {
		log.Fatalf("open store: %v", err)
	}
	defer st.close()

	srv := &server{
		cfg:         cfg,
		store:       st,
		limiter:     newRateLimiter(),
		mailer:      &brevoMailer{apiKey: cfg.brevoKey, from: cfg.mailFrom},
		modelsProxy: buildProxy(cfg.ollamaURL, "/v1/models"),
		chatProxy:   buildProxy(cfg.ollamaURL, "/v1/chat/completions"),
	}
	srv.jobs = newJobManager(st, srv)

	hs := &http.Server{
		Addr:              cfg.addr,
		Handler:           srv.routes(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	log.Printf("backend listening on %s", cfg.addr)
	if err := hs.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("server: %v", err)
	}
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func mustEnv(k string) string {
	v := os.Getenv(k)
	if v == "" {
		log.Fatalf("%s must be set", k)
	}
	return v
}

func parseAllowed(s string) map[string]bool {
	m := map[string]bool{}
	for _, e := range strings.Split(s, ",") {
		e = strings.TrimSpace(strings.ToLower(e))
		if e != "" {
			m[e] = true
		}
	}
	return m
}

func (s *server) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("POST /api/auth/request", s.handleAuthRequest)
	mux.HandleFunc("GET /api/auth/verify", s.handleAuthVerify)
	mux.HandleFunc("GET /api/auth/me", s.handleAuthMe)
	mux.HandleFunc("POST /api/auth/logout", s.handleAuthLogout)

	mux.HandleFunc("GET /api/models", s.requireAuth(s.handleModels))
	mux.HandleFunc("POST /api/chat/completions", s.requireAuth(s.handleChat))
	mux.HandleFunc("GET /api/jobs/active", s.requireAuth(s.handleActiveJobs))
	mux.HandleFunc("GET /api/conversations", s.requireAuth(s.handleListConversations))
	mux.HandleFunc("GET /api/conversations/{id}", s.requireAuth(s.handleGetConversation))
	mux.HandleFunc("POST /api/conversations", s.requireAuth(s.handleCreateConversation))
	mux.HandleFunc("PUT /api/conversations/{id}", s.requireAuth(s.handleUpdateConversation))
	mux.HandleFunc("PATCH /api/conversations/{id}", s.requireAuth(s.handlePatchConversation))
	mux.HandleFunc("DELETE /api/conversations/{id}", s.requireAuth(s.handleDeleteConversation))
	mux.HandleFunc("POST /api/conversations/{id}/generate", s.requireAuth(s.handleGenerate))
	mux.HandleFunc("GET /api/conversations/{id}/events", s.requireAuth(s.handleEvents))
	mux.HandleFunc("GET /api/conversations/{id}/job", s.requireAuth(s.handleJob))
	mux.HandleFunc("GET /api/folders", s.requireAuth(s.handleListFolders))
	mux.HandleFunc("POST /api/folders", s.requireAuth(s.handleCreateFolder))
	mux.HandleFunc("PUT /api/folders/{id}", s.requireAuth(s.handleRenameFolder))
	mux.HandleFunc("DELETE /api/folders/{id}", s.requireAuth(s.handleDeleteFolder))
	return mux
}

func (s *server) requireAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		email, ok := s.sessionEmail(r)
		if !ok {
			jsonError(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		ctx := context.WithValue(r.Context(), ctxEmail, email)
		next(w, r.WithContext(ctx))
	}
}

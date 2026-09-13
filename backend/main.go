package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

type config struct {
	addr             string
	sessionSecret    []byte
	cookieSecure     bool
	brevoKey         string
	appBaseURL       string
	mailFrom         string
	allowedEmails    map[string]bool
	dbPath           string
	ollamaURL        string
	searxngURL       string
	maxSearchRounds  int
	maxClarifyRounds int
	// askUserInPlainChat offers the ask_user tool on every plain-chat turn for
	// tool-capable models (not just under the Clarify extra), so a clarifying
	// question renders as an interactive card instead of prose. Default on.
	askUserInPlainChat bool
	// clarifyProseDetect best-effort turns a question the model wrote as prose
	// into an interactive card (fallback for small/non-tool models that don't
	// call ask_user). Default on.
	clarifyProseDetect bool
	// Agent harness: hard cap on tool-calling rounds per run. Small models loop
	// on tools; the budget forces a final synthesized answer. Env-tunable.
	maxAgentSteps int
	// Agent harness: enable the fetch_page tool (off by default). It raises the
	// prompt-injection surface — the model reads untrusted web content — so it is
	// gated behind an explicit env opt-in rather than on for everyone.
	fetchPageEnabled bool
	// Model-management fit/perf guidance. contextLength mirrors the Ollama
	// container's OLLAMA_CONTEXT_LENGTH so the backend can estimate the KV-cache
	// RAM a model will consume at the configured context.
	contextLength      int
	nasRamGB           float64
	nasSystemReserveGB float64
	// Optional secondary Ollama backend (e.g. a Mac on the LAN/Tailscale) with
	// more RAM for bigger models. Empty macURL disables it; the NAS stays the
	// only backend and behavior is unchanged from the single-host design.
	macURL             string
	macRamGB           float64
	macSystemReserveGB float64
	// maxConcurrentJobs sizes the generation worker pool (jobManager). A
	// browser-relay job blocks its worker while it awaits the user's browser, so
	// with a single worker one local-model chat used to stall every other chat.
	maxConcurrentJobs int
	// browserRelayGrace is how long a browser-bound job (local inference, or a
	// repo-bound agent run relaying file tools) is kept alive after its
	// connection-of-record drops, waiting for a reattach (chat switch, reload)
	// before being cancelled. See job.scheduleGraceCancel.
	browserRelayGrace time.Duration
	// agentJobTimeout bounds an agent-mode generation. Longer than genTimeout
	// because apply_patch/run_command/git_* block on a user approval dialog.
	agentJobTimeout time.Duration
	// toolExecTimeout bounds a single toolExec relay round-trip (the browser
	// running a file tool and POSTing the observation back). Longer than a
	// plain tool call because several of these tools also wait on approval.
	toolExecTimeout time.Duration
}

type server struct {
	cfg     config
	store   *store
	limiter *rateLimiter
	mailer  mailer
	// hosts is the multi-backend routing authority (NAS default + optional Mac).
	// chatProxies/modelsProxies are per-host streaming reverse proxies, keyed by
	// host.name, built once at startup from the registry's host URLs.
	hosts         *hostRegistry
	chatProxies   map[string]http.Handler
	modelsProxies map[string]http.Handler
	jobs          *jobManager
	pulls         *pullManager
	// hub is the per-user multiplexed stream backing GET /api/events. Jobs
	// publish modelCall/toolExec/phase/done/joberror events to it so a
	// backgrounded chat's browser relay and sidebar/notification UI keep
	// working without a dedicated per-conversation tail.
	hub *eventHub
}

type ctxKey int

const ctxEmail ctxKey = 0

func main() {
	cfg := config{
		addr:               ":" + env("BACKEND_PORT", "8081"),
		sessionSecret:      []byte(mustEnv("SESSION_SECRET")),
		brevoKey:           env("BREVO_API_KEY", ""),
		appBaseURL:         env("APP_BASE_URL", "https://chat.selected.systems"),
		mailFrom:           env("MAIL_FROM", "noreply@selected.systems"),
		dbPath:             env("DB_PATH", "/data/nas-llm.db"),
		ollamaURL:          env("OLLAMA_URL", "http://ollama:11434"),
		searxngURL:         env("SEARXNG_URL", ""),
		maxSearchRounds:    envInt("MAX_SEARCH_ROUNDS", 1),
		maxClarifyRounds:   envInt("MAX_CLARIFY_ROUNDS", 3),
		askUserInPlainChat: envBool("ASK_USER_IN_PLAIN_CHAT", true),
		clarifyProseDetect: envBool("CLARIFY_PROSE_DETECT", true),
		maxAgentSteps:      envInt("MAX_AGENT_STEPS", 6),
		fetchPageEnabled:   envBool("FETCH_PAGE_ENABLED", false),
		contextLength:      envInt("OLLAMA_CONTEXT_LENGTH", 16384),
		nasRamGB:           envFloat("NAS_RAM_GB", 8),
		nasSystemReserveGB: envFloat("NAS_SYSTEM_RESERVE_GB", 1.5),
		macURL:             env("OLLAMA_MAC_URL", ""),
		macRamGB:           envFloat("MAC_RAM_GB", 16),
		macSystemReserveGB: envFloat("MAC_SYSTEM_RESERVE_GB", 2),
		maxConcurrentJobs:  envInt("MAX_CONCURRENT_JOBS", 4),
		browserRelayGrace:  envDuration("BROWSER_RELAY_GRACE", 45*time.Second),
		agentJobTimeout:    envDuration("AGENT_JOB_TIMEOUT", 30*time.Minute),
		toolExecTimeout:    envDuration("TOOL_EXEC_TIMEOUT", 15*time.Minute),
	}
	cfg.cookieSecure = strings.HasPrefix(cfg.appBaseURL, "https://")
	cfg.allowedEmails = parseAllowed(os.Getenv("ALLOWED_EMAILS"))

	st, err := newStore(cfg.dbPath)
	if err != nil {
		log.Fatalf("open store: %v", err)
	}
	defer st.close()

	// Build the backend host list. The NAS is always present (always-on, small
	// models); a Mac is added only when OLLAMA_MAC_URL is set, becoming a second
	// backend whose RAM holds bigger models. The registry probes each host's
	// /api/tags and resolves model→host so inference routes to the right one.
	hosts := []*host{{name: "nas", url: cfg.ollamaURL, ramGB: cfg.nasRamGB, reserveGB: cfg.nasSystemReserveGB}}
	if cfg.macURL != "" {
		hosts = append(hosts, &host{name: "mac", url: cfg.macURL, ramGB: cfg.macRamGB, reserveGB: cfg.macSystemReserveGB})
	}
	hostReg := newHostRegistry(hosts)
	hostReg.start()

	srv := &server{
		cfg:           cfg,
		store:         st,
		limiter:       newRateLimiter(),
		mailer:        &brevoMailer{apiKey: cfg.brevoKey, from: cfg.mailFrom},
		hosts:         hostReg,
		chatProxies:   map[string]http.Handler{},
		modelsProxies: map[string]http.Handler{},
		hub:           newEventHub(),
	}
	for _, h := range hostReg.all() {
		srv.chatProxies[h.name] = buildProxy(h.url, "/v1/chat/completions")
		srv.modelsProxies[h.name] = buildProxy(h.url, "/v1/models")
	}
	srv.jobs = newJobManager(st, srv)
	srv.pulls = newPullManager(srv)

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

func envInt(k string, def int) int {
	if v := os.Getenv(k); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return def
}

func envFloat(k string, def float64) float64 {
	if v := os.Getenv(k); v != "" {
		if n, err := strconv.ParseFloat(v, 64); err == nil && n > 0 {
			return n
		}
	}
	return def
}

func envBool(k string, def bool) bool {
	if v := strings.ToLower(strings.TrimSpace(os.Getenv(k))); v != "" {
		return v == "1" || v == "true" || v == "yes" || v == "on"
	}
	return def
}

// envDuration parses a Go duration string (e.g. "45s", "30m") from the named
// env var, falling back to def on empty/invalid input. Used for the
// human-in-the-loop timeouts (contract 6), which need units coarser than
// envInt's bare seconds.
func envDuration(k string, def time.Duration) time.Duration {
	if v := os.Getenv(k); v != "" {
		if d, err := time.ParseDuration(v); err == nil && d > 0 {
			return d
		}
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
	mux.HandleFunc("GET /api/models/catalog", s.requireAuth(s.handleModelCatalog))
	mux.HandleFunc("GET /api/models/library", s.requireAuth(s.handleModelLibrary))
	mux.HandleFunc("GET /api/models/library/tags", s.requireAuth(s.handleModelLibraryTags))
	mux.HandleFunc("GET /api/models/preflight", s.requireAuth(s.handleModelPreflight))
	mux.HandleFunc("POST /api/models/pull", s.requireAuth(s.handleModelPull))
	mux.HandleFunc("GET /api/models/pulls/active", s.requireAuth(s.handleActivePulls))
	mux.HandleFunc("GET /api/models/pull/{jobId}/events", s.requireAuth(s.handlePullEvents))
	mux.HandleFunc("POST /api/models/pull/{jobId}/cancel", s.requireAuth(s.handlePullCancel))
	mux.HandleFunc("DELETE /api/models/{name}", s.requireAuth(s.handleModelDelete))
	mux.HandleFunc("POST /api/models/{name}/benchmark", s.requireAuth(s.handleModelBenchmark))
	mux.HandleFunc("GET /api/models/{name}/info", s.requireAuth(s.handleModelInfo))
	mux.HandleFunc("POST /api/chat/completions", s.requireAuth(s.handleChat))
	mux.HandleFunc("GET /api/jobs/active", s.requireAuth(s.handleActiveJobs))
	mux.HandleFunc("GET /api/events", s.requireAuth(s.handleUserEvents))
	mux.HandleFunc("GET /api/conversations", s.requireAuth(s.handleListConversations))
	mux.HandleFunc("GET /api/conversations/{id}", s.requireAuth(s.handleGetConversation))
	mux.HandleFunc("POST /api/conversations", s.requireAuth(s.handleCreateConversation))
	mux.HandleFunc("PUT /api/conversations/{id}", s.requireAuth(s.handleUpdateConversation))
	mux.HandleFunc("PATCH /api/conversations/{id}", s.requireAuth(s.handlePatchConversation))
	mux.HandleFunc("DELETE /api/conversations/{id}", s.requireAuth(s.handleDeleteConversation))
	mux.HandleFunc("POST /api/conversations/{id}/generate", s.requireAuth(s.handleGenerate))
	mux.HandleFunc("POST /api/conversations/{id}/model-response", s.requireAuth(s.handleModelResponse))
	mux.HandleFunc("POST /api/conversations/{id}/cancel", s.requireAuth(s.handleCancel))
	mux.HandleFunc("GET /api/conversations/{id}/events", s.requireAuth(s.handleEvents))
	mux.HandleFunc("GET /api/conversations/{id}/job", s.requireAuth(s.handleJob))
	mux.HandleFunc("GET /api/folders", s.requireAuth(s.handleListFolders))
	mux.HandleFunc("POST /api/folders", s.requireAuth(s.handleCreateFolder))
	mux.HandleFunc("PUT /api/folders/{id}", s.requireAuth(s.handleRenameFolder))
	mux.HandleFunc("DELETE /api/folders/{id}", s.requireAuth(s.handleDeleteFolder))
	mux.HandleFunc("GET /api/agent/config", s.requireAuth(s.handleAgentConfigGet))
	mux.HandleFunc("PUT /api/agent/config", s.requireAuth(s.handleAgentConfigPut))
	mux.HandleFunc("POST /api/conversations/{id}/tool-response", s.requireAuth(s.handleToolResponse))
	mux.HandleFunc("GET /api/repos", s.requireAuth(s.handleListRepos))
	mux.HandleFunc("POST /api/repos", s.requireAuth(s.handleRepoUpsert))
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

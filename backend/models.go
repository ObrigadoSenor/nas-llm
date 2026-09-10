package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"
)

// --- Ollama native API types -----------------------------------------------
// These model the native /api endpoints (not the OpenAI /v1 shim). We call
// them directly so we can parse pull progress and generate stats.

type ollamaModelDetails struct {
	ParentModel       string   `json:"parent_model"`
	Format            string   `json:"format"`
	Family            string   `json:"family"`
	Families          []string `json:"families"`
	ParameterSize     string   `json:"parameter_size"`
	QuantizationLevel string   `json:"quantization_level"`
}

type ollamaModel struct {
	Name       string             `json:"name"`
	Model      string             `json:"model"`
	ModifiedAt string             `json:"modified_at"`
	Size       int64              `json:"size"`
	Digest     string             `json:"digest"`
	Details    ollamaModelDetails `json:"details"`
}

type ollamaTagsResponse struct {
	Models []ollamaModel `json:"models"`
}

type ollamaShowResponse struct {
	Modelfile    string             `json:"modelfile"`
	Parameters   string             `json:"parameters"`
	Template     string             `json:"template"`
	System       string             `json:"system"`
	License      string             `json:"license"`
	Details      ollamaModelDetails `json:"details"`
	Capabilities []string           `json:"capabilities"`
	ModelInfo    map[string]any     `json:"model_info"`
	ModifiedAt   string             `json:"modified_at"`
}

type ollamaProgressResponse struct {
	Status    string `json:"status"`
	Digest    string `json:"digest,omitempty"`
	Total     int64  `json:"total,omitempty"`
	Completed int64  `json:"completed,omitempty"`
}

type ollamaGenerateResponse struct {
	Model              string `json:"model"`
	Response           string `json:"response"`
	Done               bool   `json:"done"`
	TotalDuration      int64  `json:"total_duration"`
	LoadDuration       int64  `json:"load_duration"`
	PromptEvalCount    int    `json:"prompt_eval_count"`
	PromptEvalDuration int64  `json:"prompt_eval_duration"`
	EvalCount          int    `json:"eval_count"`
	EvalDuration       int64  `json:"eval_duration"`
}

// benchmark is the last measured generate-speed sample for a model.
type benchmark struct {
	Model           string  `json:"model"`
	TokPerSec       float64 `json:"tokPerSec"`
	PromptTokPerSec float64 `json:"promptTokPerSec"`
	LoadMs          int64   `json:"loadMs"`
	EvaluatedAt     int64   `json:"evaluatedAt"`
}

// ollamaRequest issues a request to the native Ollama API, forcing Host to
// localhost:11434 and stripping Origin/Referer — the same dance the Caddy
// reverse proxy and streamFromOllama do, because Ollama 403s non-localhost
// Hosts and any request carrying an Origin.
func (s *server) ollamaRequest(ctx context.Context, method, path string, body any) (*http.Response, error) {
	var rdr io.Reader
	if body != nil {
		payload, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		rdr = bytes.NewReader(payload)
	}
	target := strings.TrimRight(s.cfg.ollamaURL, "/") + path
	req, err := http.NewRequestWithContext(ctx, method, target, rdr)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Host = "localhost:11434"
	req.Header.Del("Origin")
	req.Header.Del("Referer")
	return http.DefaultClient.Do(req)
}

func (s *server) ollamaTags(ctx context.Context) ([]ollamaModel, error) {
	resp, err := s.ollamaRequest(ctx, http.MethodGet, "/api/tags", nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("ollama %s", resp.Status)
	}
	var t ollamaTagsResponse
	if err := json.NewDecoder(resp.Body).Decode(&t); err != nil {
		return nil, err
	}
	return t.Models, nil
}

// --- Pull jobs (mirror the generation job system in jobs.go) ----------------
// A single pull worker keeps one download at a time on the NAS (8 GB, NVMe)
// and lets the UI tail progress over SSE with reconnect-safe replay.

var errPullActive = fmt.Errorf("a pull is already running")

type layerProg struct {
	completed, total int64
}

type pullEvent struct {
	kind      string // "progress", "phase", "done", "error"
	percent   float64
	completed int64
	total     int64
	phase     string
	text      string
}

type pullJob struct {
	id        string
	model     string
	createdAt int64

	mu              sync.Mutex
	status          string // queued, pulling, success, error, cancelled
	percent         float64
	completed       int64
	total           int64
	phase           string
	errMsg          string
	layers          map[string]layerProg
	subs            map[chan pullEvent]struct{}
	finished        chan struct{}
	cancelFn        context.CancelFunc
	cancelRequested bool
}

type pullSnapshot struct {
	Status    string  `json:"status"`
	Percent   float64 `json:"percent"`
	Completed int64   `json:"completed"`
	Total     int64   `json:"total"`
	Phase     string  `json:"phase"`
	Model     string  `json:"model"`
}

func newPullJobID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("%x", time.Now().UnixNano())
	}
	return hex.EncodeToString(b)
}

func newPullJob(model string) *pullJob {
	return &pullJob{
		id:        newPullJobID(),
		model:     model,
		createdAt: time.Now().UnixMilli(),
		status:    "queued",
		layers:    map[string]layerProg{},
		subs:      map[chan pullEvent]struct{}{},
		finished:  make(chan struct{}),
	}
}

func (j *pullJob) emitProgress(percent float64, completed, total int64) {
	j.mu.Lock()
	j.percent = percent
	j.completed = completed
	j.total = total
	subs := make([]chan pullEvent, 0, len(j.subs))
	for ch := range j.subs {
		subs = append(subs, ch)
	}
	j.mu.Unlock()
	ev := pullEvent{kind: "progress", percent: percent, completed: completed, total: total}
	for _, ch := range subs {
		select {
		case ch <- ev:
		default:
		}
	}
}

func (j *pullJob) emitPhase(phase string) {
	j.mu.Lock()
	j.phase = phase
	subs := make([]chan pullEvent, 0, len(j.subs))
	for ch := range j.subs {
		subs = append(subs, ch)
	}
	j.mu.Unlock()
	ev := pullEvent{kind: "phase", phase: phase}
	for _, ch := range subs {
		select {
		case ch <- ev:
		default:
		}
	}
}

func (j *pullJob) snapshot() (status string, percent float64, completed, total int64, phase, errMsg string) {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.status, j.percent, j.completed, j.total, j.phase, j.errMsg
}

func (j *pullJob) subscribe() (chan pullEvent, pullSnapshot) {
	ch := make(chan pullEvent, 64)
	j.mu.Lock()
	j.subs[ch] = struct{}{}
	snap := pullSnapshot{Status: j.status, Percent: j.percent, Completed: j.completed, Total: j.total, Phase: j.phase, Model: j.model}
	j.mu.Unlock()
	return ch, snap
}

func (j *pullJob) unsubscribe(ch chan pullEvent) {
	j.mu.Lock()
	delete(j.subs, ch)
	j.mu.Unlock()
}

func (j *pullJob) cancel() {
	j.mu.Lock()
	j.cancelRequested = true
	c := j.cancelFn
	j.mu.Unlock()
	if c != nil {
		c()
	}
}

func (j *pullJob) notifyTerminal(status, errMsg string) {
	j.mu.Lock()
	if j.status == "success" || j.status == "error" || j.status == "cancelled" {
		j.mu.Unlock()
		return
	}
	j.status = status
	j.errMsg = errMsg
	subs := make([]chan pullEvent, 0, len(j.subs))
	for ch := range j.subs {
		subs = append(subs, ch)
	}
	close(j.finished)
	j.mu.Unlock()
	for _, ch := range subs {
		var ev pullEvent
		if status == "error" {
			ev = pullEvent{kind: "error", text: errMsg}
		} else {
			ev = pullEvent{kind: "done"}
		}
		select {
		case ch <- ev:
		default:
		}
	}
}

// ingestProgress turns an Ollama /api/pull NDJSON line into subscriber events,
// aggregating byte progress across all download layers for a smooth bar.
func (j *pullJob) ingestProgress(p ollamaProgressResponse) {
	status := strings.TrimSpace(p.Status)
	if status == "success" {
		j.emitPhase("success")
		return
	}
	if p.Digest != "" && p.Total > 0 {
		j.mu.Lock()
		j.layers[p.Digest] = layerProg{p.Completed, p.Total}
		j.mu.Unlock()
	}
	if strings.HasPrefix(status, "downloading") {
		j.mu.Lock()
		var completed, total int64
		for _, l := range j.layers {
			completed += l.completed
			total += l.total
		}
		j.mu.Unlock()
		var pct float64
		if total > 0 {
			pct = float64(completed) / float64(total) * 100
		}
		j.emitProgress(pct, completed, total)
		return
	}
	if status != "" {
		j.emitPhase(status)
	}
}

type pullManager struct {
	mu     sync.Mutex
	active map[string]*pullJob // keyed by job id; at most one entry (single worker)
	queue  chan *pullJob
	srv    *server
}

func newPullManager(srv *server) *pullManager {
	pm := &pullManager{
		active: map[string]*pullJob{},
		queue:  make(chan *pullJob, 16),
		srv:    srv,
	}
	go pm.worker()
	return pm
}

func (pm *pullManager) activeJob() *pullJob {
	pm.mu.Lock()
	defer pm.mu.Unlock()
	for _, j := range pm.active {
		return j
	}
	return nil
}

func (pm *pullManager) get(id string) *pullJob {
	pm.mu.Lock()
	defer pm.mu.Unlock()
	return pm.active[id]
}

func (pm *pullManager) enqueue(j *pullJob) error {
	pm.mu.Lock()
	if len(pm.active) > 0 {
		pm.mu.Unlock()
		return errPullActive
	}
	pm.active[j.id] = j
	pm.mu.Unlock()
	pm.queue <- j
	return nil
}

func (pm *pullManager) cancel(id string) bool {
	pm.mu.Lock()
	j, ok := pm.active[id]
	pm.mu.Unlock()
	if !ok {
		return false
	}
	j.cancel()
	return true
}

func (pm *pullManager) worker() {
	for j := range pm.queue {
		j.mu.Lock()
		if j.cancelRequested {
			j.mu.Unlock()
			j.notifyTerminal("cancelled", "")
			pm.mu.Lock()
			delete(pm.active, j.id)
			pm.mu.Unlock()
			continue
		}
		j.status = "pulling"
		j.mu.Unlock()
		j.emitPhase("pulling manifest")

		err := pm.srv.runPull(j)

		j.mu.Lock()
		cancelled := j.cancelRequested
		j.mu.Unlock()
		switch {
		case cancelled:
			j.notifyTerminal("cancelled", "")
		case err != nil:
			j.notifyTerminal("error", err.Error())
		default:
			// Auto-benchmark so the user sees real tok/s immediately after a
			// download, without an extra click. Non-fatal: a benchmark failure
			// (e.g. an unloadable model) never undoes a successful pull.
			j.emitPhase("benchmarking")
			if br, berr := pm.srv.runBenchmark(j.model); berr != nil {
				log.Printf("auto-benchmark %s: %v", j.model, berr)
			} else {
				_ = pm.srv.store.upsertBenchmark(j.model, br.TokPerSec, br.PromptTokPerSec, br.LoadMs)
			}
			j.notifyTerminal("success", "")
		}
		pm.mu.Lock()
		delete(pm.active, j.id)
		pm.mu.Unlock()
	}
}

// runPull streams Ollama POST /api/pull NDJSON and drives the job's broadcast.
// It runs on a background context so a browser disconnect never aborts the
// download; cancel() fires the context to stop an in-flight pull.
func (s *server) runPull(j *pullJob) error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()
	j.mu.Lock()
	j.cancelFn = cancel
	j.mu.Unlock()

	resp, err := s.ollamaRequest(ctx, http.MethodPost, "/api/pull", map[string]any{"model": j.model, "stream": true})
	if err != nil {
		return fmt.Errorf("pull request failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("ollama pull %s: %s", resp.Status, strings.TrimSpace(string(body)))
	}
	br := bufio.NewReader(resp.Body)
	for {
		line, err := br.ReadBytes('\n')
		if len(line) > 0 {
			var p ollamaProgressResponse
			if json.Unmarshal(bytes.TrimSpace(line), &p) == nil {
				j.ingestProgress(p)
			}
		}
		if err != nil {
			if err == io.EOF {
				return nil
			}
			return fmt.Errorf("pull stream lost: %w", err)
		}
	}
}

func pullStateFrom(j *pullJob) map[string]any {
	st, pct, completed, total, phase, errMsg := j.snapshot()
	return map[string]any{
		"jobId":     j.id,
		"model":     j.model,
		"status":    st,
		"percent":   pct,
		"completed": completed,
		"total":     total,
		"phase":     phase,
		"error":     errMsg,
		"createdAt": j.createdAt,
	}
}

// --- Curated catalog + fit/perf estimation ---------------------------------

type catalogEntry struct {
	Name           string     `json:"name"`
	Family         string     `json:"family"`
	Params         string     `json:"params"`
	Quant          string     `json:"quant"`
	SizeGB         float64    `json:"sizeGB"`
	ContextWindow  int        `json:"contextWindow"`
	Capabilities   []string   `json:"capabilities"`
	Blurb          string     `json:"blurb"`
	EstTokPerSec   [2]float64 `json:"estTokPerSec"` // [lo, hi]; [0,0] = n/a
	RecommendedFor string     `json:"recommendedFor"`
	// Architecture dims (hidden from JSON) power the pre-download KV-cache
	// estimate; real dims come from /api/show once installed.
	Layers  int `json:"-"`
	KVHeads int `json:"-"`
	HeadDim int `json:"-"`
}

type modelVerdict struct {
	Fit          string     `json:"fit"`          // "fits" | "tight" | "no"
	RAMUsedGB    float64    `json:"ramUsedGB"`
	AvailableGB  float64    `json:"availableGB"`
	KVCacheGB    float64    `json:"kvCacheGB"`
	Speed        string     `json:"speed"`        // "fast" | "usable" | "slow" | "unknown"
	EstTokPerSec [2]float64 `json:"estTokPerSec,omitempty"`
}

type catalogItem struct {
	catalogEntry
	Installed bool         `json:"installed"`
	Verdict   modelVerdict `json:"verdict"`
}

// curatedCatalog is a hand-picked set of models known to run on an Intel N100
// with 8 GB RAM (CPU-only inference). Ollama has no registry search API, so
// this is the browse list; a free-text pull covers anything else.
var curatedCatalog = []catalogEntry{
	{
		Name: "qwen3:1.7b", Family: "qwen3", Params: "1.7B", Quant: "Q4_K_M",
		SizeGB: 1.1, ContextWindow: 32768, Capabilities: []string{"tools", "thinking", "completion"},
		Blurb: "Very fast little model. Great for quick answers and tool/web-search calls.",
		EstTokPerSec: [2]float64{10, 16}, RecommendedFor: "Fast replies, web search",
		Layers: 28, KVHeads: 8, HeadDim: 128,
	},
	{
		Name: "llama3.2:3b", Family: "llama", Params: "3B", Quant: "Q4_K_M",
		SizeGB: 2.0, ContextWindow: 128000, Capabilities: []string{"completion"},
		Blurb: "The sweet spot on 8 GB. Solid general chat and page summarizing.",
		EstTokPerSec: [2]float64{7, 11}, RecommendedFor: "General chat, summarizing",
		Layers: 28, KVHeads: 8, HeadDim: 128,
	},
	{
		Name: "qwen2.5:3b", Family: "qwen2.5", Params: "3B", Quant: "Q4_K_M",
		SizeGB: 1.9, ContextWindow: 32768, Capabilities: []string{"tools", "completion"},
		Blurb: "Strong reasoning for its size and tool-capable. A good 3B alternative.",
		EstTokPerSec: [2]float64{6, 10}, RecommendedFor: "Reasoning, tool calls",
		Layers: 36, KVHeads: 2, HeadDim: 128,
	},
	{
		Name: "phi3:mini", Family: "phi3", Params: "3.8B", Quant: "Q4_K_M",
		SizeGB: 2.2, ContextWindow: 128000, Capabilities: []string{"completion"},
		Blurb: "Microsoft's small model. Decent reasoning, long context window.",
		EstTokPerSec: [2]float64{4, 8}, RecommendedFor: "Long-context notes",
		Layers: 32, KVHeads: 32, HeadDim: 96,
	},
	{
		Name: "gemma3:4b", Family: "gemma3", Params: "4B", Quant: "Q4_K_M",
		SizeGB: 2.5, ContextWindow: 128000, Capabilities: []string{"vision", "completion"},
		Blurb: "Multimodal — understands images as well as text. Slower than the 3B models.",
		EstTokPerSec: [2]float64{5, 9}, RecommendedFor: "Image + text",
		Layers: 35, KVHeads: 1, HeadDim: 256,
	},
	{
		Name: "llama3.1:8b", Family: "llama3", Params: "8B", Quant: "Q4_K_M",
		SizeGB: 4.7, ContextWindow: 128000, Capabilities: []string{"tools", "completion"},
		Blurb: "Best quality here, but slow and RAM-heavy on 8 GB. Shorten its context.",
		EstTokPerSec: [2]float64{2, 4}, RecommendedFor: "Best quality (slow)",
		Layers: 32, KVHeads: 8, HeadDim: 128,
	},
	{
		Name: "nomic-embed-text", Family: "nomic-bert", Params: "0.1B", Quant: "f16",
		SizeGB: 0.27, ContextWindow: 8192, Capabilities: []string{"embedding"},
		Blurb: "Embeddings for search/RAG — not a chat model. Tiny and fast.",
		EstTokPerSec: [2]float64{0, 0}, RecommendedFor: "Embeddings",
	},
}

// estimateKV approximates the fp16 KV-cache RAM (GB, decimal) a model needs at
// a given context: 2 (K+V) * layers * ctx * kv_heads * head_dim * 2 bytes.
func (s *server) estimateKV(layers, kvHeads, headDim, ctx int) float64 {
	if layers <= 0 || kvHeads <= 0 || headDim <= 0 || ctx <= 0 {
		return 0
	}
	return float64(2*layers*ctx*kvHeads*headDim*2) / 1e9
}

func (s *server) verdictFor(e catalogEntry) modelVerdict {
	available := s.cfg.nasRamGB - s.cfg.nasSystemReserveGB
	ctx := s.cfg.contextLength
	if ctx <= 0 {
		ctx = e.ContextWindow
	}
	if e.ContextWindow > 0 && ctx > e.ContextWindow {
		ctx = e.ContextWindow
	}
	kv := s.estimateKV(e.Layers, e.KVHeads, e.HeadDim, ctx)
	used := e.SizeGB + kv
	v := modelVerdict{
		RAMUsedGB:    used,
		AvailableGB:  available,
		KVCacheGB:    kv,
		EstTokPerSec: e.EstTokPerSec,
	}
	switch {
	case used <= available:
		v.Fit = "fits"
	case used <= available+1.0:
		v.Fit = "tight"
	default:
		v.Fit = "no"
	}
	if e.EstTokPerSec[0] <= 0 && e.EstTokPerSec[1] <= 0 {
		v.Speed = "unknown"
	} else {
		mid := (e.EstTokPerSec[0] + e.EstTokPerSec[1]) / 2
		switch {
		case mid >= 12:
			v.Speed = "fast"
		case mid >= 6:
			v.Speed = "usable"
		default:
			v.Speed = "slow"
		}
	}
	return v
}

func (s *server) installedModelSet(ctx context.Context) map[string]bool {
	out := map[string]bool{}
	models, err := s.ollamaTags(ctx)
	if err != nil {
		return out
	}
	for _, m := range models {
		name := m.Name
		if name == "" {
			name = m.Model
		}
		out[name] = true
	}
	return out
}

// numVal reads an int from a model_info map (values arrive as float64 via JSON).
func numVal(m map[string]any, key string) int {
	if v, ok := m[key]; ok {
		switch n := v.(type) {
		case float64:
			return int(n)
		case int:
			return n
		}
	}
	return 0
}

// dimsFromModelInfo extracts (layers, kv_heads, head_dim) using the model's
// architecture prefix (general.architecture, falling back to details.family).
func dimsFromModelInfo(m map[string]any, family string) (layers, kvHeads, headDim int) {
	arch := family
	if a, ok := m["general.architecture"].(string); ok && a != "" {
		arch = a
	}
	layers = numVal(m, arch+".block_count")
	kvHeads = numVal(m, arch+".attention.head_count_kv")
	headDim = numVal(m, arch+".attention.key_length")
	return
}

// --- Handlers (all session-auth-gated, registered in main.go) ---------------

// handleModels lists installed models with size/details + last benchmark. It
// keeps the OpenAI {data:[{id}]} shape the existing selector expects, falling
// back to the plain /v1/models proxy if /api/tags is unavailable.
func (s *server) handleModels(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	models, err := s.ollamaTags(ctx)
	if err != nil {
		s.modelsProxy.ServeHTTP(w, r)
		return
	}
	out := make([]map[string]any, 0, len(models))
	for _, m := range models {
		name := m.Name
		if name == "" {
			name = m.Model
		}
		item := map[string]any{
			"id":         name,
			"name":       name,
			"size":       m.Size,
			"sizeGB":     float64(m.Size) / 1e9,
			"digest":     m.Digest,
			"modifiedAt": m.ModifiedAt,
			"details":    m.Details,
		}
		if b := s.store.getBenchmark(name); b != nil {
			item["benchmark"] = b
		}
		out = append(out, item)
	}
	writeJSON(w, map[string]any{"data": out})
}

func (s *server) handleModelCatalog(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	installed := s.installedModelSet(ctx)
	out := make([]catalogItem, 0, len(curatedCatalog))
	for _, e := range curatedCatalog {
		out = append(out, catalogItem{catalogEntry: e, Installed: installed[e.Name], Verdict: s.verdictFor(e)})
	}
	writeJSON(w, map[string]any{
		"models": out,
		"nas": map[string]any{
			"ramGB":         s.cfg.nasRamGB,
			"reserveGB":     s.cfg.nasSystemReserveGB,
			"contextLength": s.cfg.contextLength,
			"availableGB":   s.cfg.nasRamGB - s.cfg.nasSystemReserveGB,
		},
	})
}

func (s *server) handleModelPull(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Model string `json:"model"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, "invalid request", http.StatusBadRequest)
		return
	}
	model := strings.TrimSpace(body.Model)
	if model == "" {
		jsonError(w, "model is required", http.StatusBadRequest)
		return
	}
	if existing := s.pulls.activeJob(); existing != nil {
		w.WriteHeader(http.StatusConflict)
		writeJSON(w, pullStateFrom(existing))
		return
	}
	j := newPullJob(model)
	if err := s.pulls.enqueue(j); err != nil {
		if existing := s.pulls.activeJob(); existing != nil {
			w.WriteHeader(http.StatusConflict)
			writeJSON(w, pullStateFrom(existing))
			return
		}
		log.Printf("pull enqueue: %v", err)
		jsonError(w, "server error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusAccepted)
	writeJSON(w, pullStateFrom(j))
}

func (s *server) handleActivePulls(w http.ResponseWriter, r *http.Request) {
	j := s.pulls.activeJob()
	if j == nil {
		writeJSON(w, map[string]any{})
		return
	}
	writeJSON(w, map[string]any{j.id: pullStateFrom(j)})
}

func (s *server) handlePullCancel(w http.ResponseWriter, r *http.Request) {
	if !s.pulls.cancel(r.PathValue("jobId")) {
		jsonError(w, "no active pull for this job", http.StatusNotFound)
		return
	}
	writeJSON(w, map[string]string{"status": "cancelled"})
}

// handlePullEvents is the SSE tail for a pull. It replays the last aggregated
// progress as "reset" (so reconnects re-anchor), then streams live progress /
// phase / done / error with a keepalive so Cloudflare's 100s edge timeout
// never fires during a long download.
func (s *server) handlePullEvents(w http.ResponseWriter, r *http.Request) {
	j := s.pulls.get(r.PathValue("jobId"))
	if j == nil {
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

	ch, snap := j.subscribe()
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

	sdata, _ := json.Marshal(snap)
	writeSSE("event: reset\ndata: " + string(sdata) + "\n\n")
	if st, _, _, _, _, _ := j.snapshot(); st == "queued" {
		writeSSE("event: phase\ndata: queued\n\n")
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

	flushProgress := func(ev pullEvent) {
		d, _ := json.Marshal(map[string]any{"percent": ev.percent, "completed": ev.completed, "total": ev.total})
		writeSSE("event: progress\ndata: " + string(d) + "\n\n")
	}
	flushPhase := func(ev pullEvent) {
		writeSSE("event: phase\ndata: " + ev.phase + "\n\n")
	}
	flushError := func(ev pullEvent) {
		d, _ := json.Marshal(ev.text)
		writeSSE("event: joberror\ndata: " + string(d) + "\n\n")
	}

	for {
		select {
		case <-r.Context().Done():
			return
		case ev := <-ch:
			switch ev.kind {
			case "progress":
				flushProgress(ev)
			case "phase":
				flushPhase(ev)
			case "done":
				writeSSE("event: done\ndata: \n\n")
				return
			case "error":
				flushError(ev)
				return
			}
		case <-j.finished:
			draining := true
			for draining {
				select {
				case ev := <-ch:
					switch ev.kind {
					case "progress":
						flushProgress(ev)
					case "phase":
						flushPhase(ev)
					case "done":
						writeSSE("event: done\ndata: \n\n")
						return
					case "error":
						flushError(ev)
						return
					}
				default:
					draining = false
				}
			}
			st, _, _, _, _, msg := j.snapshot()
			if st == "error" {
				flushError(pullEvent{kind: "error", text: msg})
			} else {
				writeSSE("event: done\ndata: \n\n")
			}
			return
		}
	}
}

func (s *server) handleModelDelete(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if name == "" {
		jsonError(w, "model is required", http.StatusBadRequest)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	resp, err := s.ollamaRequest(ctx, http.MethodDelete, "/api/delete", map[string]any{"model": name})
	if err != nil {
		jsonError(w, "could not reach ollama", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		jsonError(w, "model not found", http.StatusNotFound)
		return
	}
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		jsonError(w, "ollama: "+strings.TrimSpace(string(body)), resp.StatusCode)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// benchmarkResult holds the measured speed sample from a short generation.
type benchmarkResult struct {
	TokPerSec       float64
	PromptTokPerSec float64
	LoadMs          int64
	EvalCount       int
	PromptEvalCount int
}

// runBenchmark drives a short non-streaming generation and returns measured
// tok/s from Ollama's eval stats: tok/s = eval_count / eval_duration * 1e9.
// It runs on a background context so it works detached from any HTTP request
// (used by both the manual benchmark handler and the post-pull auto-benchmark).
func (s *server) runBenchmark(model string) (*benchmarkResult, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	resp, err := s.ollamaRequest(ctx, http.MethodPost, "/api/generate", map[string]any{
		"model":   model,
		"prompt":  "Write a numbered list of three short facts about the ocean.",
		"stream":  false,
		"options": map[string]any{"num_predict": 64, "temperature": 0},
	})
	if err != nil {
		return nil, fmt.Errorf("could not reach ollama: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return nil, fmt.Errorf("ollama: %s", strings.TrimSpace(string(body)))
	}
	var g ollamaGenerateResponse
	if err := json.NewDecoder(resp.Body).Decode(&g); err != nil {
		return nil, fmt.Errorf("unreadable response: %w", err)
	}
	br := &benchmarkResult{EvalCount: g.EvalCount, PromptEvalCount: g.PromptEvalCount, LoadMs: g.LoadDuration / int64(1e6)}
	if g.EvalDuration > 0 && g.EvalCount > 0 {
		br.TokPerSec = float64(g.EvalCount) / float64(g.EvalDuration) * 1e9
	}
	if g.PromptEvalDuration > 0 && g.PromptEvalCount > 0 {
		br.PromptTokPerSec = float64(g.PromptEvalCount) / float64(g.PromptEvalDuration) * 1e9
	}
	return br, nil
}

// handleModelBenchmark is the manual, on-demand benchmark endpoint. It reuses
// runBenchmark and persists the result so it shows across browsers/reloads.
func (s *server) handleModelBenchmark(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if name == "" {
		jsonError(w, "model is required", http.StatusBadRequest)
		return
	}
	br, err := s.runBenchmark(name)
	if err != nil {
		jsonError(w, err.Error(), http.StatusBadGateway)
		return
	}
	if err := s.store.upsertBenchmark(name, br.TokPerSec, br.PromptTokPerSec, br.LoadMs); err != nil {
		log.Printf("upsertBenchmark: %v", err)
	}
	writeJSON(w, map[string]any{
		"model":           name,
		"tokPerSec":       br.TokPerSec,
		"promptTokPerSec": br.PromptTokPerSec,
		"loadMs":          br.LoadMs,
		"evalCount":       br.EvalCount,
		"promptEvalCount": br.PromptEvalCount,
		"evaluatedAt":     time.Now().UnixMilli(),
	})
}

// handleModelInfo returns /api/show details (architecture, capabilities) merged
// with on-disk size and the last benchmark, plus a KV-cache estimate from the
// model's real dims at the configured context.
func (s *server) handleModelInfo(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if name == "" {
		jsonError(w, "model is required", http.StatusBadRequest)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	resp, err := s.ollamaRequest(ctx, http.MethodPost, "/api/show", map[string]any{"model": name})
	if err != nil {
		jsonError(w, "could not reach ollama", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		jsonError(w, "model not found", http.StatusNotFound)
		return
	}
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		jsonError(w, "ollama: "+strings.TrimSpace(string(body)), resp.StatusCode)
		return
	}
	var show ollamaShowResponse
	if err := json.NewDecoder(resp.Body).Decode(&show); err != nil {
		jsonError(w, "unreadable response", http.StatusBadGateway)
		return
	}

	layers, kvHeads, headDim := dimsFromModelInfo(show.ModelInfo, show.Details.Family)
	arch := show.Details.Family
	if a, ok := show.ModelInfo["general.architecture"].(string); ok && a != "" {
		arch = a
	}
	native := numVal(show.ModelInfo, arch+".context_length")
	ctxLen := s.cfg.contextLength
	if native > 0 && ctxLen > native {
		ctxLen = native
	}
	kv := s.estimateKV(layers, kvHeads, headDim, ctxLen)
	sizeGB := 0.0
	if models, err := s.ollamaTags(ctx); err == nil {
		for _, m := range models {
			mn := m.Name
			if mn == "" {
				mn = m.Model
			}
			if mn == name {
				sizeGB = float64(m.Size) / 1e9
				break
			}
		}
	}
	available := s.cfg.nasRamGB - s.cfg.nasSystemReserveGB
	used := sizeGB + kv
	fit := "fits"
	switch {
	case used <= available:
		fit = "fits"
	case used <= available+1.0:
		fit = "tight"
	default:
		fit = "no"
	}
	out := map[string]any{
		"name":          name,
		"details":       show.Details,
		"capabilities":  show.Capabilities,
		"modelInfo":     show.ModelInfo,
		"sizeGB":        sizeGB,
		"kvCacheGB":     kv,
		"ramUsedGB":     used,
		"availableGB":   available,
		"contextLength": ctxLen,
		"fit":           fit,
		"layers":        layers,
		"kvHeads":       kvHeads,
		"headDim":       headDim,
	}
	if b := s.store.getBenchmark(name); b != nil {
		out["benchmark"] = b
	}
	writeJSON(w, out)
}

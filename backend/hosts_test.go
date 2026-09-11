package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// fakeOllama is a stand-in Ollama backend for routing tests. It implements the
// native /api endpoints and the OpenAI /v1/chat/completions shim enough for the
// host registry and every routed call (tags/pull/generate/chat/show/delete) to
// be exercised and asserted against. Per-endpoint hit counters record which
// backend a request landed on — the crux of multi-host routing verification.
type fakeOllama struct {
	server *httptest.Server

	mu    sync.RWMutex
	tags  []ollamaModel
	added []string // models added via /api/pull, in order (for assertions)

	tagsHits   int64
	pullHits   int64
	genHits    int64
	chatHits   int64
	showHits   int64
	deleteHits int64
}

func newFakeOllama(t *testing.T, models ...string) *fakeOllama {
	t.Helper()
	f := &fakeOllama{}
	for _, m := range models {
		f.tags = append(f.tags, ollamaModel{Name: m, Model: m, Size: 2_000_000_000})
	}
	f.server = httptest.NewServer(http.HandlerFunc(f.handle))
	t.Cleanup(f.server.Close)
	return f
}

func (f *fakeOllama) addModel(name string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.tags = append(f.tags, ollamaModel{Name: name, Model: name, Size: 2_000_000_000})
	f.added = append(f.added, name)
}

func (f *fakeOllama) snapshotTags() []ollamaModel {
	f.mu.RLock()
	defer f.mu.RUnlock()
	out := make([]ollamaModel, len(f.tags))
	copy(out, f.tags)
	return out
}

func (f *fakeOllama) handle(w http.ResponseWriter, r *http.Request) {
	switch r.Method + " " + r.URL.Path {
	case "GET /api/tags":
		atomic.AddInt64(&f.tagsHits, 1)
		writeJSON(w, ollamaTagsResponse{Models: f.snapshotTags()})
	case "POST /api/pull":
		atomic.AddInt64(&f.pullHits, 1)
		// A real pull makes the model appear in /api/tags once it lands. Simulate
		// that so the registry's post-pull refreshOne observes the new model.
		var body struct {
			Model string `json:"model"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body.Model != "" {
			f.addModel(body.Model)
		}
		w.Header().Set("Content-Type", "application/x-ndjson")
		fmt.Fprintln(w, `{"status":"pulling manifest"}`)
		fmt.Fprintln(w, `{"status":"downloading","digest":"sha256:abc","total":100,"completed":100}`)
		fmt.Fprintln(w, `{"status":"success"}`)
	case "POST /api/generate":
		atomic.AddInt64(&f.genHits, 1)
		// 64 tokens in 1s → 64 tok/s; enough for runBenchmark to parse cleanly.
		writeJSON(w, ollamaGenerateResponse{
			Model: "x", Response: "ok", Done: true,
			EvalCount: 64, EvalDuration: 1_000_000_000,
			PromptEvalCount: 10, PromptEvalDuration: 500_000_000,
			LoadDuration: 200_000_000,
		})
	case "POST /v1/chat/completions":
		atomic.AddInt64(&f.chatHits, 1)
		w.Header().Set("Content-Type", "text/event-stream")
		// One content delta, then [DONE] — exactly what streamFromOllama parses.
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n")
		fmt.Fprint(w, "data: [DONE]\n\n")
		if fl, ok := w.(http.Flusher); ok {
			fl.Flush()
		}
	case "POST /api/show":
		atomic.AddInt64(&f.showHits, 1)
		writeJSON(w, ollamaShowResponse{})
	case "DELETE /api/delete":
		atomic.AddInt64(&f.deleteHits, 1)
		w.WriteHeader(http.StatusOK)
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

// newTestRegistry builds a registry over the given fakes (NAS first) and probes
// every host once so online state + tags are populated without waiting for the
// 30s background ticker (which we never start in tests).
func newTestRegistry(t *testing.T, fakes ...*fakeOllama) (*hostRegistry, []*host) {
	t.Helper()
	hosts := make([]*host, len(fakes))
	for i, f := range fakes {
		ram, reserve := 8.0, 1.5
		if i == 1 { // mac gets a bigger budget by convention in these tests
			ram, reserve = 32.0, 4.0
		}
		hosts[i] = &host{name: []string{"nas", "mac"}[i], url: f.server.URL, ramGB: ram, reserveGB: reserve}
	}
	reg := newHostRegistry(hosts)
	reg.refresh() // probe all hosts (newHostRegistry only probes hosts[0])
	return reg, hosts
}

func TestHostRegistry_OnlineModelResolutionAndMerge(t *testing.T) {
	nas := newFakeOllama(t, "llama3.2:3b")
	mac := newFakeOllama(t, "mistral:7b")
	reg, hosts := newTestRegistry(t, nas, mac)

	if !reg.isOnline(hosts[0]) || !reg.isOnline(hosts[1]) {
		t.Fatalf("both hosts should be online; nas=%v mac=%v", reg.isOnline(hosts[0]), reg.isOnline(hosts[1]))
	}
	// Routing core: a model resolves to the host that has it installed.
	if got := reg.onlineHostForModel("llama3.2:3b"); got != hosts[0] {
		t.Errorf("llama3.2:3b should route to nas, got %q", got.name)
	}
	if got := reg.onlineHostForModel("mistral:7b"); got != hosts[1] {
		t.Errorf("mistral:7b should route to mac, got %q", got.name)
	}
	// A model on no online host resolves to nil (the fail-fast signal runGeneration
	// uses when the Mac is offline).
	if got := reg.onlineHostForModel("does-not-exist"); got != nil {
		t.Errorf("unknown model should resolve to nil, got %q", got.name)
	}
	// Merged list spans every online host.
	pairs := reg.onlineTagPairs()
	if len(pairs) != 2 {
		t.Fatalf("onlineTagPairs should return 2 hosts, got %d", len(pairs))
	}
	total := 0
	for _, p := range pairs {
		total += len(p.tags)
	}
	if total != 2 {
		t.Errorf("merged tags should total 2 models, got %d", total)
	}
	// defaultHost is always the NAS (hosts[0]).
	if reg.defaultHost() != hosts[0] {
		t.Errorf("defaultHost should be nas")
	}
}

func TestHostRegistry_OfflineHostDropsItsModels(t *testing.T) {
	nas := newFakeOllama(t, "llama3.2:3b")
	mac := newFakeOllama(t, "mistral:7b")
	reg, hosts := newTestRegistry(t, nas, mac)

	// Simulate the Mac going offline (asleep / left the network) by closing its
	// server and re-probing. Its model must drop out of resolution.
	mac.server.Close()
	reg.refreshOne(hosts[1])

	if reg.isOnline(hosts[1]) {
		t.Fatalf("mac should be offline after its server closed")
	}
	if got := reg.onlineHostForModel("mistral:7b"); got != nil {
		t.Errorf("mistral:7b should not resolve when mac is offline, got %q", got.name)
	}
	// NAS models keep working — the always-on backend is unaffected.
	if got := reg.onlineHostForModel("llama3.2:3b"); got != hosts[0] {
		t.Errorf("nas model should still resolve when mac is offline, got %q", nameOrEmpty(got))
	}
}

func TestHostRegistry_RefreshAfterMutation(t *testing.T) {
	nas := newFakeOllama(t)
	mac := newFakeOllama(t, "mistral:7b")
	reg, hosts := newTestRegistry(t, nas, mac)

	if got := reg.onlineHostForModel("qwen2.5:14b"); got != nil {
		t.Fatalf("qwen2.5:14b should not exist yet, got %q", got.name)
	}
	// Mac pulls a new model (out of band); after refreshOne the registry sees it.
	mac.addModel("qwen2.5:14b")
	reg.refreshOne(hosts[1])
	if got := reg.onlineHostForModel("qwen2.5:14b"); got != hosts[1] {
		t.Errorf("qwen2.5:14b should route to mac after refresh, got %q", nameOrEmpty(got))
	}
}

func TestOllamaRequest_RoutesToNamedHost(t *testing.T) {
	nas := newFakeOllama(t, "llama3.2:3b")
	mac := newFakeOllama(t, "mistral:7b")
	reg, hosts := newTestRegistry(t, nas, mac)
	srv := &server{cfg: config{contextLength: 8192}, hosts: reg}

	// newTestRegistry already probed each host's /api/tags once (via reg.refresh),
	// so assert deltas from this baseline rather than absolute counts.
	nasBefore := atomic.LoadInt64(&nas.tagsHits)
	macBefore := atomic.LoadInt64(&mac.tagsHits)

	// A nil host falls back to the default (NAS).
	if _, err := srv.ollamaRequest(context.Background(), nil, http.MethodGet, "/api/tags", nil); err != nil {
		t.Fatalf("nil-host request: %v", err)
	}
	if got := atomic.LoadInt64(&nas.tagsHits) - nasBefore; got != 1 {
		t.Errorf("nil host should hit nas tags once (delta), got %d", got)
	}
	if got := atomic.LoadInt64(&mac.tagsHits) - macBefore; got != 0 {
		t.Errorf("nil host should not hit mac (delta), got %d", got)
	}

	// An explicit Mac host hits the Mac (and not the NAS).
	nasBefore = atomic.LoadInt64(&nas.tagsHits)
	macBefore = atomic.LoadInt64(&mac.tagsHits)
	if _, err := srv.ollamaRequest(context.Background(), hosts[1], http.MethodGet, "/api/tags", nil); err != nil {
		t.Fatalf("mac-host request: %v", err)
	}
	if got := atomic.LoadInt64(&mac.tagsHits) - macBefore; got != 1 {
		t.Errorf("mac host should hit mac tags once (delta), got %d", got)
	}
	if got := atomic.LoadInt64(&nas.tagsHits) - nasBefore; got != 0 {
		t.Errorf("mac host should not hit nas (delta), got %d", got)
	}
}

func TestRunStreamPass_RoutesToTargetHost(t *testing.T) {
	nas := newFakeOllama(t, "llama3.2:3b")
	mac := newFakeOllama(t, "mistral:7b")
	reg, hosts := newTestRegistry(t, nas, mac)
	srv := &server{cfg: config{contextLength: 8192}, hosts: reg}

	var got strings.Builder
	emit := func(s string) { got.WriteString(s) }

	// NAS model → NAS chat endpoint. The backend dials the resolved host's chat
	// URL and streams content live through emit.
	mb := &directOllama{chatURL: hosts[0].chatURL(), emit: emit}
	if err := srv.runStreamPass(context.Background(), mb, "llama3.2:3b",
		[]oaiMessage{{Role: "user", Content: jsonString("hi")}}, emit); err != nil {
		t.Fatalf("runStreamPass nas: %v", err)
	}
	if got.String() != "hi" {
		t.Errorf("emitted content = %q, want %q", got.String(), "hi")
	}
	if c := atomic.LoadInt64(&nas.chatHits); c != 1 {
		t.Errorf("nas chat should be hit once, got %d", c)
	}
	if c := atomic.LoadInt64(&mac.chatHits); c != 0 {
		t.Errorf("mac chat should not be hit, got %d", c)
	}

	// Mac model → Mac chat endpoint.
	got.Reset()
	mb = &directOllama{chatURL: hosts[1].chatURL(), emit: emit}
	if err := srv.runStreamPass(context.Background(), mb, "mistral:7b",
		[]oaiMessage{{Role: "user", Content: jsonString("hi")}}, emit); err != nil {
		t.Fatalf("runStreamPass mac: %v", err)
	}
	if c := atomic.LoadInt64(&mac.chatHits); c != 1 {
		t.Errorf("mac chat should be hit once, got %d", c)
	}
}

func TestRunBenchmark_RoutesToOwningHost(t *testing.T) {
	nas := newFakeOllama(t, "llama3.2:3b")
	mac := newFakeOllama(t, "mistral:7b")
	reg, hosts := newTestRegistry(t, nas, mac)
	srv := &server{cfg: config{contextLength: 8192}, hosts: reg}

	// Benchmarking a Mac model must drive the Mac's /api/generate, not the NAS's.
	br, err := srv.runBenchmark("mistral:7b", hosts[1])
	if err != nil {
		t.Fatalf("runBenchmark: %v", err)
	}
	if br.TokPerSec != 64 {
		t.Errorf("tokPerSec = %v, want 64", br.TokPerSec)
	}
	if c := atomic.LoadInt64(&mac.genHits); c != 1 {
		t.Errorf("mac generate should be hit, got %d", c)
	}
	if c := atomic.LoadInt64(&nas.genHits); c != 0 {
		t.Errorf("nas generate should not be hit, got %d", c)
	}
}

func TestRunPull_RoutesToTargetHost(t *testing.T) {
	nas := newFakeOllama(t)
	mac := newFakeOllama(t)
	reg, hosts := newTestRegistry(t, nas, mac)
	srv := &server{cfg: config{contextLength: 8192}, hosts: reg}

	// Pulling onto the Mac must POST /api/pull to the Mac backend.
	j := newPullJob("mistral:7b", hosts[1])
	if err := srv.runPull(j); err != nil {
		t.Fatalf("runPull: %v", err)
	}
	if c := atomic.LoadInt64(&mac.pullHits); c != 1 {
		t.Errorf("mac pull should be hit, got %d", c)
	}
	if c := atomic.LoadInt64(&nas.pullHits); c != 0 {
		t.Errorf("nas pull should not be hit, got %d", c)
	}
	// The fake pull handler registered the model on the Mac, as a real Ollama would.
	if !containsModel(mac.snapshotTags(), "mistral:7b") {
		t.Errorf("mistral:7b should be present on mac after pull")
	}
}

func TestPullManager_AutoBenchmarkAndRefreshOnTargetHost(t *testing.T) {
	nas := newFakeOllama(t)
	mac := newFakeOllama(t) // starts empty; the pull adds the model
	reg, hosts := newTestRegistry(t, nas, mac)

	st, err := newStore(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("newStore: %v", err)
	}
	defer st.close()
	srv := &server{cfg: config{contextLength: 8192}, hosts: reg, store: st}
	pm := newPullManager(srv)

	// The model is not yet resolvable (Mac is online but empty).
	if got := reg.onlineHostForModel("mistral:7b"); got != nil {
		t.Fatalf("mistral:7b should not resolve before pull, got %q", got.name)
	}

	j := newPullJob("mistral:7b", hosts[1])
	if err := pm.enqueue(j); err != nil {
		t.Fatalf("enqueue: %v", err)
	}
	// Wait for the single worker to finish the pull → auto-benchmark → refresh.
	select {
	case <-j.finished:
	case <-time.After(15 * time.Second):
		t.Fatalf("pull job did not finish in time")
	}

	// Pull hit the Mac, never the NAS.
	if c := atomic.LoadInt64(&mac.pullHits); c != 1 {
		t.Errorf("mac pull should be hit once, got %d", c)
	}
	if c := atomic.LoadInt64(&nas.pullHits); c != 0 {
		t.Errorf("nas pull should not be hit, got %d", c)
	}
	// Auto-benchmark ran on the Mac (the owning host), not the NAS.
	if c := atomic.LoadInt64(&mac.genHits); c != 1 {
		t.Errorf("mac generate (auto-benchmark) should be hit once, got %d", c)
	}
	if c := atomic.LoadInt64(&nas.genHits); c != 0 {
		t.Errorf("nas generate should not be hit, got %d", c)
	}
	// The worker's post-pull refreshOne made the model resolvable on the Mac.
	if got := reg.onlineHostForModel("mistral:7b"); got != hosts[1] {
		t.Errorf("mistral:7b should resolve to mac after pull, got %q", nameOrEmpty(got))
	}
	// And the benchmark was persisted.
	if b := st.getBenchmark("mistral:7b"); b == nil || b.TokPerSec != 64 {
		t.Errorf("benchmark should be persisted at 64 tok/s, got %+v", b)
	}
}

func TestVerdictFor_HostAwareRAM(t *testing.T) {
	nas := newFakeOllama(t, "llama3.2:3b")
	mac := newFakeOllama(t, "mistral:7b")
	reg, _ := newTestRegistry(t, nas, mac) // nas 8GB/1.5 reserve, mac 32GB/4 reserve
	srv := &server{cfg: config{contextLength: 8192}, hosts: reg}

	// A 14B (~8.4 GB) model tagged for the Mac must be judged against the Mac's
	// 28 GB budget (fits), while the same size on the NAS (6.5 GB budget) is "no".
	macEntry := catalogEntry{Name: "qwen2.5:14b", Host: "mac", SizeGB: 8.4, ContextWindow: 32768}
	v := srv.verdictFor(macEntry)
	if v.Fit != "fits" {
		t.Errorf("mac-tagged 14B should fit on mac (avail %.1f), got %q", v.AvailableGB, v.Fit)
	}
	if v.AvailableGB != 28.0 {
		t.Errorf("mac verdict should use mac available 28 GB, got %.1f", v.AvailableGB)
	}

	nasEntry := catalogEntry{Name: "qwen2.5:14b", SizeGB: 8.4, ContextWindow: 32768} // Host "" → nas
	v2 := srv.verdictFor(nasEntry)
	if v2.Fit != "no" {
		t.Errorf("nas-tagged 14B should not fit on nas (avail %.1f), got %q", v2.AvailableGB, v2.Fit)
	}
	if v2.AvailableGB != 6.5 {
		t.Errorf("nas verdict should use nas available 6.5 GB, got %.1f", v2.AvailableGB)
	}

	// An entry tagged for a host that isn't configured falls back to the default.
	soloReg := newHostRegistry([]*host{{name: "nas", url: nas.server.URL, ramGB: 8, reserveGB: 1.5}})
	soloSrv := &server{cfg: config{contextLength: 8192}, hosts: soloReg}
	v3 := soloSrv.verdictFor(macEntry) // mac not configured → nas budget
	if v3.AvailableGB != 6.5 {
		t.Errorf("mac entry with no mac configured should fall back to nas budget 6.5, got %.1f", v3.AvailableGB)
	}
}

// --- helpers ---

func containsModel(tags []ollamaModel, name string) bool {
	for _, m := range tags {
		if modelTagName(m) == name {
			return true
		}
	}
	return false
}

func nameOrEmpty(h *host) string {
	if h == nil {
		return "<nil>"
	}
	return h.name
}

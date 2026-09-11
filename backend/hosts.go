package main

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"time"
)

// host is one Ollama backend the chat service can route inference and model
// management to. The NAS (registry entry 0) is the always-on default for small
// models; a Mac — or any other machine with more RAM — is an optional secondary
// backend whose memory holds bigger models. Each host carries its own RAM budget
// so fit guidance is computed against the host that would actually run a model.
type host struct {
	name      string
	url       string
	ramGB     float64
	reserveGB float64
}

// chatURL is the OpenAI-compatible chat-completions endpoint on this host.
func (h *host) chatURL() string {
	return strings.TrimRight(h.url, "/") + "/v1/chat/completions"
}

// availableGB is the RAM left for model weights + KV cache on this host.
func (h *host) availableGB() float64 {
	return h.ramGB - h.reserveGB
}

// hostState is a cached probe result: whether the host answered /api/tags and
// the model list it reported. Refreshed periodically by the registry.
type hostState struct {
	online bool
	tags   []ollamaModel
}

const (
	hostProbeTimeout    = 3 * time.Second
	hostRefreshInterval = 30 * time.Second
)

// hostRegistry resolves model→host and tracks per-host online state + tags. It
// is the single routing authority for the backend: every inference and model-
// management call asks it which host owns a model before dialing Ollama, so a
// model installed on the Mac is served from the Mac while NAS models stay on the
// NAS — all behind one chat URL.
type hostRegistry struct {
	mu    sync.RWMutex
	hosts []*host // ordered; hosts[0] is the default (NAS)
	state map[string]hostState
}

// newHostRegistry builds a registry over the given hosts (hosts[0] is the
// default). It probes the default host synchronously so the NAS model list is
// populated before the first request; secondary hosts are probed by start().
func newHostRegistry(hosts []*host) *hostRegistry {
	r := &hostRegistry{
		hosts: hosts,
		state: map[string]hostState{},
	}
	for _, h := range hosts {
		r.state[h.name] = hostState{online: false}
	}
	// Seed the default host as online (probed synchronously below) so a cold
	// start still routes to the NAS even if the first probe is still in flight.
	if len(hosts) > 0 {
		r.state[hosts[0].name] = hostState{online: true}
		r.refreshOne(hosts[0])
	}
	return r
}

// start launches the background refresher that re-probes every host on a timer
// so online/offline state and installed-model lists stay fresh without callers
// ever dialing Ollama directly.
func (r *hostRegistry) start() {
	go func() {
		r.refresh()
		t := time.NewTicker(hostRefreshInterval)
		defer t.Stop()
		for range t.C {
			r.refresh()
		}
	}()
}

// defaultHost is the always-on host (NAS) used when a model isn't found on any
// online host — inference still tries it so Ollama returns a clean not-found
// rather than the backend inventing an error.
func (r *hostRegistry) defaultHost() *host {
	if len(r.hosts) == 0 {
		return nil
	}
	return r.hosts[0]
}

// all returns every configured host (online or not).
func (r *hostRegistry) all() []*host { return r.hosts }

// hostByName returns the configured host with the given name, or nil.
func (r *hostRegistry) hostByName(name string) *host {
	for _, h := range r.hosts {
		if h.name == name {
			return h
		}
	}
	return nil
}

// isOnline reports the cached online state of a host.
func (r *hostRegistry) isOnline(h *host) bool {
	if h == nil {
		return false
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.state[h.name].online
}

// onlineHostForModel returns the online host that has the model installed, or
// nil if no online host reports it. The frontend lists only online-host models,
// so a nil result means the model's host is offline (e.g. the Mac is asleep) —
// callers fail fast with a clear message instead of hanging.
func (r *hostRegistry) onlineHostForModel(model string) *host {
	r.mu.RLock()
	defer r.mu.RUnlock()
	for _, h := range r.hosts {
		st := r.state[h.name]
		if !st.online {
			continue
		}
		for _, m := range st.tags {
			if modelTagName(m) == model {
				return h
			}
		}
	}
	return nil
}

// hostTagPairs is one online host plus its installed models, used to merge model
// lists and compute the catalog's "installed" set across all backends.
type hostTagPairs struct {
	host *host
	tags []ollamaModel
}

// onlineTagPairs returns (host, tags) for every online host.
func (r *hostRegistry) onlineTagPairs() []hostTagPairs {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]hostTagPairs, 0, len(r.hosts))
	for _, h := range r.hosts {
		st := r.state[h.name]
		if !st.online {
			continue
		}
		out = append(out, hostTagPairs{host: h, tags: st.tags})
	}
	return out
}

// refresh probes every configured host and caches the result.
func (r *hostRegistry) refresh() {
	for _, h := range r.hosts {
		r.refreshOne(h)
	}
}

// refreshOne probes a single host and caches the result. Safe to call
// concurrently; callers use it to refresh a host immediately after a mutation
// (pull/delete) so the merged model list reflects the change without waiting
// for the 30s tick.
func (r *hostRegistry) refreshOne(h *host) {
	if h == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), hostProbeTimeout)
	defer cancel()
	st := probeHost(ctx, h)
	r.mu.Lock()
	r.state[h.name] = st
	r.mu.Unlock()
}

// probeHost GETs /api/tags with the localhost Host header (Ollama 403s non-
// localhost Hosts and any request carrying an Origin) and returns the parsed
// tags, or online=false on any failure. This is the same dialer dance the
// Caddy reverse proxy and streamFromOllama use, applied per backend host.
func probeHost(ctx context.Context, h *host) hostState {
	target := strings.TrimRight(h.url, "/") + "/api/tags"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return hostState{online: false}
	}
	req.Host = "localhost:11434"
	req.Header.Del("Origin")
	req.Header.Del("Referer")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return hostState{online: false}
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return hostState{online: false}
	}
	var t ollamaTagsResponse
	if err := json.NewDecoder(resp.Body).Decode(&t); err != nil {
		return hostState{online: false}
	}
	return hostState{online: true, tags: t.Models}
}

// modelTagName returns the canonical name for an Ollama tags entry (Name, or
// Model if Name is empty), matching how handleModels keys the selector.
func modelTagName(m ollamaModel) string {
	if m.Name != "" {
		return m.Name
	}
	return m.Model
}

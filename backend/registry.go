package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"
)

// --- Ollama registry (OCI manifest) ----------------------------------------
// The preflight endpoint sizes a model before download by fetching its OCI
// manifest from registry.ollama.ai — the same endpoint `ollama pull` uses.
// Each layer carries an exact byte size; the application/vnd.ollama.image.model
// layer is the weights, and summing every layer gives the exact download size.
// Manifests are immutable by digest, so a short-TTL in-memory cache is safe.

// errModelNotFound is the sentinel for a registry 404 (unknown tag); the
// preflight handler maps it to a 404 response distinct from a registry outage.
var errModelNotFound = errors.New("model not found in registry")

// modelRef is a parsed OCI model reference: registry/namespace/repo:tag with
// defaults applied (registry.ollama.ai, library, latest).
type modelRef struct {
	registry  string
	namespace string
	repo      string
	tag       string
}

// parseModelRef splits an Ollama model reference into its registry, namespace,
// repo and tag, applying defaults (registry=registry.ollama.ai, namespace=
// library, tag=latest). It accepts "repo", "repo:tag", "ns/repo:tag", and the
// full "host/ns/repo:tag" form.
func parseModelRef(s string) (modelRef, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return modelRef{}, errors.New("empty model reference")
	}
	ref := modelRef{registry: "registry.ollama.ai", namespace: "library", tag: "latest"}
	parts := strings.Split(s, "/")
	// The last path segment always holds repo[:tag]; preceding segments are an
	// optional namespace and (before that) an optional registry host.
	last := parts[len(parts)-1]
	repo, tag, hasTag := splitRepoTag(last)
	if repo == "" {
		return modelRef{}, fmt.Errorf("invalid model reference %q", s)
	}
	ref.repo = repo
	if hasTag {
		if tag == "" {
			return modelRef{}, fmt.Errorf("invalid model reference %q", s)
		}
		ref.tag = tag
	}
	switch len(parts) {
	case 1:
		// repo[:tag] — namespace and registry stay defaulted.
	case 2:
		ref.namespace = parts[0]
	case 3:
		ref.registry = parts[0]
		ref.namespace = parts[1]
	default:
		return modelRef{}, fmt.Errorf("invalid model reference %q", s)
	}
	if ref.namespace == "" || ref.registry == "" {
		return modelRef{}, fmt.Errorf("invalid model reference %q", s)
	}
	return ref, nil
}

// splitRepoTag splits "repo:tag" into its parts; hasTag is false when there is
// no colon (so the caller can keep the latest default).
func splitRepoTag(s string) (repo, tag string, hasTag bool) {
	if i := strings.IndexByte(s, ':'); i >= 0 {
		return s[:i], s[i+1:], true
	}
	return s, "", false
}

// ociManifest is the Docker Distribution v2 manifest schema returned by
// registry.ollama.ai/v2/<ns>/<repo>/manifests/<tag>.
type ociManifest struct {
	SchemaVersion int        `json:"schemaVersion"`
	Config        ociLayer   `json:"config"`
	Layers        []ociLayer `json:"layers"`
}

// ociLayer is one descriptor in a manifest: a media type, digest and byte size.
type ociLayer struct {
	MediaType string `json:"mediaType"`
	Digest    string `json:"digest"`
	Size      int64  `json:"size"`
}

// manifestMediaType is the weights layer in an Ollama manifest.
const manifestMediaType = "application/vnd.ollama.image.model"

// manifestSizes computes the download size (sum of all layer bytes) and the
// weights size (the vnd.ollama.image.model layer, falling back to the largest
// layer when no model layer is present), both in decimal GB.
func manifestSizes(m *ociManifest) (downloadGB, weightsGB float64) {
	var total, weights, largest int64
	found := false
	for _, l := range m.Layers {
		total += l.Size
		if l.Size > largest {
			largest = l.Size
		}
		if l.MediaType == manifestMediaType {
			weights = l.Size
			found = true
		}
	}
	if !found {
		weights = largest
	}
	return float64(total) / 1e9, float64(weights) / 1e9
}

// manifestCacheEntry holds a fetched manifest, its derived sizes and the fetch
// time, for TTL-based caching.
type manifestCacheEntry struct {
	manifest   *ociManifest
	downloadGB float64
	weightsGB  float64
	fetchedAt  time.Time
}

var manifestCache sync.Map

const manifestCacheTTL = 30 * time.Minute

// fetchManifest returns the OCI manifest for ref, serving a cached copy when
// fresh (manifests are immutable by digest) and otherwise fetching with a 15s
// timeout and a 2 MiB body cap. A registry 404 yields errModelNotFound; other
// non-200 statuses yield an error wrapping the status. registry.ollama.ai is a
// normal HTTPS registry, so no localhost Host-header dance is applied here —
// that dance is only for talking to the Ollama backend servers (ollamaRequest,
// probeHost, buildProxy), not the registry.
func fetchManifest(ctx context.Context, ref modelRef) (*ociManifest, error) {
	key := ref.repo + ":" + ref.tag
	if v, ok := manifestCache.Load(key); ok {
		if e, ok := v.(manifestCacheEntry); ok && time.Since(e.fetchedAt) < manifestCacheTTL {
			return e.manifest, nil
		}
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	m, err := fetchManifestHTTP(ctx, ref)
	if err != nil {
		return nil, err
	}
	dl, w := manifestSizes(m)
	manifestCache.Store(key, manifestCacheEntry{manifest: m, downloadGB: dl, weightsGB: w, fetchedAt: time.Now()})
	return m, nil
}

// fetchManifestHTTP issues the registry GET for a manifest.
func fetchManifestHTTP(ctx context.Context, ref modelRef) (*ociManifest, error) {
	u := fmt.Sprintf("https://%s/v2/%s/%s/manifests/%s", ref.registry, ref.namespace, ref.repo, ref.tag)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.docker.distribution.manifest.v2+json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("registry unreachable: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return nil, errModelNotFound
	}
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return nil, manifestStatusError(resp.StatusCode, string(body))
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if err != nil {
		return nil, fmt.Errorf("reading manifest: %w", err)
	}
	var m ociManifest
	if err := json.Unmarshal(body, &m); err != nil {
		return nil, fmt.Errorf("parsing manifest: %w", err)
	}
	return &m, nil
}

// manifestStatusError maps a non-200 registry status to an error, turning 404
// into the errModelNotFound sentinel so callers can branch on it. Extracted as
// a pure helper so the 404 mapping is testable without a network call.
func manifestStatusError(status int, body string) error {
	if status == http.StatusNotFound {
		return errModelNotFound
	}
	return fmt.Errorf("registry returned %d: %s", status, strings.TrimSpace(body))
}

// fitVerdict classifies used GB against an available budget: "fits" within the
// budget, "tight" within 1 GB over, otherwise "no". Mirrors verdictFor's bands.
func fitVerdict(used, available float64) string {
	switch {
	case used <= available:
		return "fits"
	case used <= available+1.0:
		return "tight"
	default:
		return "no"
	}
}

// preflightFit computes the RAM used (weights + KV cache) and fit verdict for a
// model against a target host's available GB. Cataloged models reuse the
// verdictFor-style KV estimate from their architecture dims at the configured
// context (clamped to the model's context window); unknown models get no KV
// estimate (unknown arch), so RAM used is the weights alone.
func (s *server) preflightFit(e *catalogEntry, weightsGB, availableGB float64) (ramUsedGB, kvCacheGB float64, fit string) {
	if e != nil {
		ctx := s.cfg.contextLength
		if ctx <= 0 {
			ctx = e.ContextWindow
		}
		if e.ContextWindow > 0 && ctx > e.ContextWindow {
			ctx = e.ContextWindow
		}
		kv := s.estimateKV(e.Layers, e.KVHeads, e.HeadDim, ctx)
		used := weightsGB + kv
		return used, kv, fitVerdict(used, availableGB)
	}
	return weightsGB, 0, fitVerdict(weightsGB, availableGB)
}

// preflightResponse is the JSON contract shared with the frontend preflight
// fetcher. The fit-related fields are pointers so host=local renders them as
// null (the backend can't know the visitor's RAM); error is always null on 200.
type preflightResponse struct {
	Model         string   `json:"model"`
	Host          string   `json:"host"`
	DownloadGB    float64  `json:"downloadGB"`
	WeightsGB     float64  `json:"weightsGB"`
	RAMUsedGB     *float64 `json:"ramUsedGB"`
	AvailableGB   *float64 `json:"availableGB"`
	KVCacheGB     *float64 `json:"kvCacheGB"`
	Fit           *string  `json:"fit"`
	Cataloged     bool     `json:"cataloged"`
	ContextLength int      `json:"contextLength"`
	Error         *string  `json:"error"`
}

// handleModelPreflight returns pre-download size and fit info for a model by
// fetching its OCI manifest from the Ollama registry. Session-auth-gated and
// registered in main.go alongside the other model routes. Query params: model
// (required) and host (nas|mac|local|auto, default auto). An unknown tag yields
// 404 {"error":"model not found in registry"}; a registry failure yields 502
// {"error":"model library unavailable: ..."}.
func (s *server) handleModelPreflight(w http.ResponseWriter, r *http.Request) {
	model := strings.TrimSpace(r.URL.Query().Get("model"))
	if model == "" {
		jsonError(w, "model is required", http.StatusBadRequest)
		return
	}
	hostParam := strings.TrimSpace(strings.ToLower(r.URL.Query().Get("host")))
	if hostParam == "" {
		hostParam = "auto"
	}
	ref, err := parseModelRef(model)
	if err != nil {
		jsonError(w, "invalid model reference", http.StatusBadRequest)
		return
	}
	// Resolve the target host whose RAM budget the fit verdict is measured
	// against. "auto" follows the catalog intent (entries tagged Host:"mac"
	// use the Mac) then the default; "nas"/"mac" name a host explicitly (an
	// unconfigured host falls back to the default); "local" is the visitor's
	// own machine, so no server host and the fit fields are nulled out.
	var target *host
	hostName := hostParam
	switch hostParam {
	case "local":
		target = nil
		hostName = "local"
	case "auto":
		if e := catalogEntryByName(model); e != nil && e.Host != "" {
			target = s.hosts.hostByName(e.Host)
		}
		if target == nil {
			target = s.hosts.defaultHost()
		}
		hostName = target.name
	default: // "nas", "mac", or any configured host name
		target = s.hosts.hostByName(hostParam)
		if target == nil {
			target = s.hosts.defaultHost()
		}
		hostName = target.name
	}
	m, err := fetchManifest(r.Context(), ref)
	if err != nil {
		if errors.Is(err, errModelNotFound) {
			jsonError(w, "model not found in registry", http.StatusNotFound)
			return
		}
		log.Printf("preflight manifest fetch %s: %v", model, err)
		jsonError(w, "model library unavailable: "+err.Error(), http.StatusBadGateway)
		return
	}
	downloadGB, weightsGB := manifestSizes(m)
	e := catalogEntryByName(model)
	resp := preflightResponse{
		Model:         model,
		Host:          hostName,
		DownloadGB:    downloadGB,
		WeightsGB:     weightsGB,
		Cataloged:     e != nil,
		ContextLength: s.cfg.contextLength,
	}
	// host=local (or no resolvable host): leave the fit fields nil so they
	// serialize as null — the backend can't judge fit against the visitor's RAM.
	if hostParam != "local" && target != nil {
		available := target.availableGB()
		ramUsed, kv, fit := s.preflightFit(e, weightsGB, available)
		resp.RAMUsedGB = f64ptr(ramUsed)
		resp.AvailableGB = f64ptr(available)
		resp.KVCacheGB = f64ptr(kv)
		resp.Fit = sptr(fit)
	}
	writeJSON(w, resp)
}

func f64ptr(v float64) *float64 { return &v }
func sptr(v string) *string     { return &v }

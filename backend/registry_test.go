package main

import (
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"testing"
)

func approxEq(a, b float64) bool { return math.Abs(a-b) < 1e-9 }

func TestParseModelRef(t *testing.T) {
	cases := []struct {
		in      string
		want    modelRef
		wantErr bool
	}{
		{"qwen3", modelRef{"registry.ollama.ai", "library", "qwen3", "latest"}, false},
		{"qwen3:8b", modelRef{"registry.ollama.ai", "library", "qwen3", "8b"}, false},
		{"mistral/qwen3:8b", modelRef{"registry.ollama.ai", "mistral", "qwen3", "8b"}, false},
		{"hf.co/bartowski/qwen3:8b", modelRef{"hf.co", "bartowski", "qwen3", "8b"}, false},
		{"llama3.2", modelRef{"registry.ollama.ai", "library", "llama3.2", "latest"}, false},
		{"", modelRef{}, true},
		{"a/b/c/d:tag", modelRef{}, true},
		{"qwen3:", modelRef{}, true},
	}
	for _, c := range cases {
		got, err := parseModelRef(c.in)
		if c.wantErr {
			if err == nil {
				t.Errorf("parseModelRef(%q): want error, got nil", c.in)
			}
			continue
		}
		if err != nil {
			t.Errorf("parseModelRef(%q): unexpected error: %v", c.in, err)
			continue
		}
		if got != c.want {
			t.Errorf("parseModelRef(%q) = %+v, want %+v", c.in, got, c.want)
		}
	}
}

// A recorded Ollama registry manifest fixture: a model (weights) layer plus the
// usual template/system/license metadata layers. No network needed.
const manifestFixture = `{
  "schemaVersion": 2,
  "mediaType": "application/vnd.docker.distribution.manifest.v2+json",
  "config": {
    "mediaType": "application/vnd.ollama.image.config",
    "digest": "sha256:config",
    "size": 512
  },
  "layers": [
    {"mediaType": "application/vnd.ollama.image.model", "digest": "sha256:weights", "size": 4700000000},
    {"mediaType": "application/vnd.ollama.image.template", "digest": "sha256:tmpl", "size": 1000000},
    {"mediaType": "application/vnd.ollama.image.system", "digest": "sha256:sys", "size": 2000000},
    {"mediaType": "application/vnd.ollama.image.license", "digest": "sha256:lic", "size": 500000}
  ]
}`

func TestManifestSizes(t *testing.T) {
	var m ociManifest
	if err := json.Unmarshal([]byte(manifestFixture), &m); err != nil {
		t.Fatalf("unmarshal fixture: %v", err)
	}
	if m.SchemaVersion != 2 {
		t.Errorf("schemaVersion = %d, want 2", m.SchemaVersion)
	}
	if len(m.Layers) != 4 {
		t.Fatalf("layers = %d, want 4", len(m.Layers))
	}
	dl, w := manifestSizes(&m)
	wantDL := float64(4700000000+1000000+2000000+500000) / 1e9
	wantW := float64(4700000000) / 1e9
	if !approxEq(dl, wantDL) {
		t.Errorf("downloadGB = %v, want %v", dl, wantDL)
	}
	if !approxEq(w, wantW) {
		t.Errorf("weightsGB = %v, want %v (the model layer)", w, wantW)
	}
}

// A manifest with no explicit model layer: weightsGB falls back to the largest.
const manifestNoModelLayerFixture = `{
  "schemaVersion": 2,
  "config": {"mediaType": "application/vnd.ollama.image.config", "digest": "sha256:c", "size": 10},
  "layers": [
    {"mediaType": "application/vnd.ollama.image.template", "digest": "sha256:t", "size": 500000000},
    {"mediaType": "application/vnd.ollama.image.license", "digest": "sha256:l", "size": 9000000000}
  ]
}`

func TestManifestSizes_FallbackLargest(t *testing.T) {
	var m ociManifest
	if err := json.Unmarshal([]byte(manifestNoModelLayerFixture), &m); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	dl, w := manifestSizes(&m)
	wantDL := float64(500000000+9000000000) / 1e9
	wantW := float64(9000000000) / 1e9 // largest layer
	if !approxEq(dl, wantDL) {
		t.Errorf("downloadGB = %v, want %v", dl, wantDL)
	}
	if !approxEq(w, wantW) {
		t.Errorf("weightsGB = %v, want %v (largest fallback)", w, wantW)
	}
}

func TestPreflightFit(t *testing.T) {
	s := &server{cfg: config{contextLength: 16384}}

	// Curated: qwen3:8b (Layers:36, KVHeads:8, HeadDim:128, ContextWindow:32768).
	// KV at 16384 ctx = 2*36*16384*8*128*2 / 1e9 ≈ 2.416 GB, so 4.7+2.416 ≈ 7.12.
	e := catalogEntryByName("qwen3:8b")
	if e == nil {
		t.Fatal("curatedCatalog missing qwen3:8b")
	}
	ramUsed, kv, fit := s.preflightFit(e, 4.7, 14.0)
	if kv <= 0 {
		t.Errorf("curated model: kvCacheGB = %v, want >0", kv)
	}
	if !approxEq(ramUsed, 4.7+kv) {
		t.Errorf("curated model: ramUsedGB = %v, want 4.7+kv=%v", ramUsed, 4.7+kv)
	}
	if fit != "fits" {
		t.Errorf("curated model: fit = %q, want \"fits\" (7.12 <= 14)", fit)
	}
	// Same model against a tiny budget: 7.12 > 5+1 -> "no".
	_, _, fitNo := s.preflightFit(e, 4.7, 5.0)
	if fitNo != "no" {
		t.Errorf("curated model @5GB: fit = %q, want \"no\"", fitNo)
	}

	// Unknown model: no KV estimate, RAM used == weights.
	ramUsedU, kvU, fitU := s.preflightFit(nil, 4.7, 6.5)
	if kvU != 0 {
		t.Errorf("unknown model: kvCacheGB = %v, want 0", kvU)
	}
	if !approxEq(ramUsedU, 4.7) {
		t.Errorf("unknown model: ramUsedGB = %v, want 4.7", ramUsedU)
	}
	if fitU != "fits" {
		t.Errorf("unknown model: fit = %q, want \"fits\" (4.7 <= 6.5)", fitU)
	}
	// Unknown, over budget: 8.0 > 6.5+1 -> "no".
	_, _, fitOver := s.preflightFit(nil, 8.0, 6.5)
	if fitOver != "no" {
		t.Errorf("unknown model @6.5GB: fit = %q, want \"no\" (8 > 7.5)", fitOver)
	}
	// Unknown, just over -> "tight": 7.0 <= 6.5+1.
	_, _, fitTight := s.preflightFit(nil, 7.0, 6.5)
	if fitTight != "tight" {
		t.Errorf("unknown model: fit = %q, want \"tight\" (7 <= 7.5)", fitTight)
	}
}

func TestManifestStatusError(t *testing.T) {
	if err := manifestStatusError(http.StatusNotFound, "not found"); !errors.Is(err, errModelNotFound) {
		t.Errorf("status 404: want errModelNotFound, got %v", err)
	}
	if err := manifestStatusError(http.StatusInternalServerError, "boom"); errors.Is(err, errModelNotFound) {
		t.Errorf("status 500: should not map to errModelNotFound, got %v", err)
	}
	if err := manifestStatusError(http.StatusUnauthorized, ""); err == nil {
		t.Errorf("status 401: want non-nil error")
	}
}

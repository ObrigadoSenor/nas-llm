package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestEmitModelCallSampling verifies the browser-relay path: when j.sampling is
// set (an agent/search/clarify run), the modelCall payload carries
// temperature/top_p (and seed when non-zero) so the browser's localhost Ollama
// call gets the same determinism steering as server-model rounds. When
// sampling is nil (plain chat), the fields are absent so Ollama uses its
// Modelfile defaults. temperature 0 (greedy) must still be sent, so it is a
// pointer, not a falsy check.
func TestEmitModelCallSampling(t *testing.T) {
	cases := []struct {
		name     string
		sampling *agentSampling
		wantTemp *float64
		wantTopP *float64
		wantSeed *int64
	}{
		{
			name:     "agent run: temp/top_p set, seed 0 omitted",
			sampling: &agentSampling{temperature: 0.4, topP: 0.9, seed: 0},
			wantTemp: ptrFloat(0.4),
			wantTopP: ptrFloat(0.9),
			wantSeed: nil,
		},
		{
			name:     "greedy temperature 0 is sent, not treated as unset",
			sampling: &agentSampling{temperature: 0, topP: 0.9, seed: 42},
			wantTemp: ptrFloat(0),
			wantTopP: ptrFloat(0.9),
			wantSeed: ptrInt(42),
		},
		{
			name:     "plain chat: sampling nil -> all fields absent",
			sampling: nil,
			wantTemp: nil,
			wantTopP: nil,
			wantSeed: nil,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			j := newJob("conv", "user@example.com", "local:1b", false, false, true)
			j.sampling = c.sampling
			j.emitModelCall("local:1b",
				[]oaiMessage{{Role: "user", Content: jsonString("hi")}},
				[]oaiTool{webSearchTool})

			mc := j.modelCallSnapshot()
			if mc == nil {
				t.Fatal("pendingModelCall should be stashed after emitModelCall")
			}
			assertPtrFloat(t, "temperature", mc.Temperature, c.wantTemp)
			assertPtrFloat(t, "top_p", mc.TopP, c.wantTopP)
			assertPtrInt(t, "seed", mc.Seed, c.wantSeed)

			// Re-serialize and confirm the JSON omits nil fields (the browser
			// keys off presence, so a stray null would change plain-chat
			// behavior).
			b, _ := json.Marshal(mc)
			s := string(b)
			if c.wantTemp == nil && strings.Contains(s, "\"temperature\"") {
				t.Errorf("plain-chat payload leaked temperature: %s", s)
			}
			if c.wantSeed == nil && strings.Contains(s, "\"seed\"") {
				t.Errorf("payload leaked seed when it should be omitted: %s", s)
			}
		})
	}
}

// TestDirectOllamaCallSampling verifies the server-model path: directOllama.Call
// populates the chat request's top-level temperature/top_p/seed fields when
// sampling is set, and omits them when nil. Uses an httptest server that
// captures the request body.
func TestDirectOllamaCallSampling(t *testing.T) {
	var gotBody []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		gotBody = b
		w.Header().Set("Content-Type", "text/event-stream")
		// One content chunk then [DONE] so streamOllamaChatWithTools returns
		// cleanly (no empty-response error).
		io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\"x\"}}]}\n\n")
		io.WriteString(w, "data: [DONE]\n\n")
	}))
	defer srv.Close()

	round := func(sampling *agentSampling) {
		gotBody = nil
		d := &directOllama{chatURL: srv.URL, emit: func(string) {}, sampling: sampling}
		_, _, err := d.Call(context.Background(), "m",
			[]oaiMessage{{Role: "user", Content: jsonString("hi")}}, nil)
		if err != nil {
			t.Fatalf("directOllama.Call: %v", err)
		}
	}

	t.Run("agent run sends temperature/top_p/seed", func(t *testing.T) {
		round(&agentSampling{temperature: 0.4, topP: 0.9, seed: 7})
		var req chatRequest
		if err := json.Unmarshal(gotBody, &req); err != nil {
			t.Fatalf("unmarshal request: %v", err)
		}
		if req.Temperature == nil || *req.Temperature != 0.4 {
			t.Errorf("temperature = %v, want 0.4", req.Temperature)
		}
		if req.TopP == nil || *req.TopP != 0.9 {
			t.Errorf("top_p = %v, want 0.9", req.TopP)
		}
		if req.Seed == nil || *req.Seed != 7 {
			t.Errorf("seed = %v, want 7", req.Seed)
		}
	})

	t.Run("seed 0 is omitted, temperature 0 is sent", func(t *testing.T) {
		round(&agentSampling{temperature: 0, topP: 0.9, seed: 0})
		var req chatRequest
		if err := json.Unmarshal(gotBody, &req); err != nil {
			t.Fatalf("unmarshal request: %v", err)
		}
		if req.Temperature == nil || *req.Temperature != 0 {
			t.Errorf("temperature = %v, want 0 (greedy must be sent)", req.Temperature)
		}
		if req.Seed != nil {
			t.Errorf("seed = %v, want nil (seed 0 = unset)", req.Seed)
		}
		if !bytes.Contains(gotBody, []byte("\"temperature\":0")) {
			t.Errorf("request body omitted temperature:0: %s", gotBody)
		}
		if bytes.Contains(gotBody, []byte("\"seed\"")) {
			t.Errorf("request body leaked seed when seed=0: %s", gotBody)
		}
	})

	t.Run("plain chat omits all sampling fields", func(t *testing.T) {
		round(nil)
		s := string(gotBody)
		for _, k := range []string{"\"temperature\"", "\"top_p\"", "\"seed\""} {
			if strings.Contains(s, k) {
				t.Errorf("plain-chat request leaked %s: %s", k, s)
			}
		}
	})
}

func ptrFloat(v float64) *float64 { return &v }
func ptrInt(v int64) *int64       { return &v }

func assertPtrFloat(t *testing.T, name string, got, want *float64) {
	t.Helper()
	switch {
	case got == nil && want == nil:
	case got == nil && want != nil:
		t.Errorf("%s = nil, want %v", name, *want)
	case got != nil && want == nil:
		t.Errorf("%s = %v, want nil (omitted)", name, *got)
	case *got != *want:
		t.Errorf("%s = %v, want %v", name, *got, *want)
	}
}

func assertPtrInt(t *testing.T, name string, got, want *int64) {
	t.Helper()
	switch {
	case got == nil && want == nil:
	case got == nil && want != nil:
		t.Errorf("%s = nil, want %d", name, *want)
	case got != nil && want == nil:
		t.Errorf("%s = %d, want nil (omitted)", name, *got)
	case *got != *want:
		t.Errorf("%s = %d, want %d", name, *got, *want)
	}
}

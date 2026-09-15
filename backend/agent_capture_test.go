package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestCaptureAgentRound verifies the opt-in debug capture writes each round's
// exact payload (model, messages, tools, sampling) to disk so it can be
// replayed standalone, and is a no-op when capture is off.
func TestCaptureAgentRound(t *testing.T) {
	st, err := newStore(filepath.Join(t.TempDir(), "cap.db"))
	if err != nil {
		t.Fatalf("newStore: %v", err)
	}
	defer st.close()
	dir := t.TempDir()
	srv := &server{cfg: config{agentDebugCapture: true, agentDebugCaptureDir: dir}, store: st}

	sampling := &agentSampling{temperature: 0.4, topP: 0.9, seed: 11}
	msgs := []oaiMessage{{Role: "user", Content: jsonString("hi")}}
	tools := []oaiTool{webSearchTool}

	srv.captureAgentRound("runXYZ", "server", "qwen3:1.7b", 2, 3, msgs, tools, sampling)

	// Find the written file (name embeds runID + round index).
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("readdir: %v", err)
	}
	var found string
	for _, e := range entries {
		if filepath.Ext(e.Name()) == ".json" {
			found = filepath.Join(dir, e.Name())
			break
		}
	}
	if found == "" {
		t.Fatal("no capture file written")
	}
	b, err := os.ReadFile(found)
	if err != nil {
		t.Fatalf("read capture: %v", err)
	}
	var rec agentDebugRound
	if err := json.Unmarshal(b, &rec); err != nil {
		t.Fatalf("unmarshal capture: %v", err)
	}
	if rec.RunID != "runXYZ" || rec.Step != 2 || rec.Round != 3 || rec.Backend != "server" || rec.Model != "qwen3:1.7b" {
		t.Errorf("capture identity = %+v, want runXYZ/step2/round3/server/qwen3:1.7b", rec)
	}
	if len(rec.Messages) != 1 || contentText(rec.Messages[0].Content) != "hi" {
		t.Errorf("capture messages = %+v, want one 'hi'", rec.Messages)
	}
	if len(rec.Tools) != 1 || rec.Tools[0].Function.Name != "web_search" {
		t.Errorf("capture tools = %+v, want [web_search]", rec.Tools)
	}
	if rec.Temperature == nil || *rec.Temperature != 0.4 || rec.TopP == nil || *rec.TopP != 0.9 || rec.Seed == nil || *rec.Seed != 11 {
		t.Errorf("capture sampling = temp=%v topP=%v seed=%v, want 0.4/0.9/11", rec.Temperature, rec.TopP, rec.Seed)
	}

	// seed 0 is omitted (matches the request/snapshot semantics).
	dir2 := t.TempDir()
	srv2 := &server{cfg: config{agentDebugCapture: true, agentDebugCaptureDir: dir2}, store: st}
	srv2.captureAgentRound("runS0", "relay", "m", 0, 1, msgs, nil, &agentSampling{temperature: 0, topP: 0.9, seed: 0})
	b2, err := os.ReadFile(filepath.Join(dir2, "agent-round-runS0-r1.json"))
	if err != nil {
		t.Fatalf("seed-0 capture file missing: %v", err)
	}
	var rec2 agentDebugRound
	if err := json.Unmarshal(b2, &rec2); err != nil {
		t.Fatalf("unmarshal seed-0 capture: %v", err)
	}
	// temperature 0 (greedy) is a real value and must be captured, not treated
	// as unset; seed 0 means unset and must be omitted.
	if rec2.Temperature == nil || *rec2.Temperature != 0 {
		t.Errorf("seed-0 capture temperature = %v, want 0 (greedy must be captured): %s", rec2.Temperature, b2)
	}
	if rec2.Seed != nil {
		t.Errorf("seed-0 capture should omit seed, got %d: %s", *rec2.Seed, b2)
	}
	if strings.Contains(string(b2), `"seed"`) {
		t.Errorf("seed-0 capture JSON leaked a seed field: %s", b2)
	}

	// Capture off → no file.
	dir3 := t.TempDir()
	srv3 := &server{cfg: config{agentDebugCapture: false, agentDebugCaptureDir: dir3}, store: st}
	srv3.captureAgentRound("runOff", "server", "m", 0, 1, msgs, nil, sampling)
	if ents, _ := os.ReadDir(dir3); len(ents) != 0 {
		t.Errorf("capture wrote files when disabled: %+v", ents)
	}
}

// TestAgentBackendInfo verifies the debug-capture helper resolves the backend
// kind and per-run sampling for each concrete backend (and falls back gracefully
// for a test fake).
func TestAgentBackendInfo(t *testing.T) {
	sm := &agentSampling{temperature: 0.4, topP: 0.9}
	if kind, got := agentBackendInfo(&directOllama{chatURL: "u", sampling: sm}); kind != "server" || got != sm {
		t.Errorf("directOllama: kind=%s sampling=%v, want server/%+v", kind, got, sm)
	}
	j := newJob("c", "u@example.com", "local:1b", false, false, true)
	j.sampling = sm
	if kind, got := agentBackendInfo(&browserRelay{j: j}); kind != "relay" || got != sm {
		t.Errorf("browserRelay: kind=%s sampling=%v, want relay/%+v", kind, got, sm)
	}
	// A test fake (non-server/relay backend) resolves to unknown/nil.
	if kind, got := agentBackendInfo(&fakeBackend{}); kind != "unknown" || got != nil {
		t.Errorf("fake backend: kind=%s sampling=%v, want unknown/nil", kind, got)
	}
}

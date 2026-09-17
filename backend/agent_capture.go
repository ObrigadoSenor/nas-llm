package main

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
)

// AGENT_DEBUG_CAPTURE is on so a failing iteration's exact payload can be
// replayed standalone (scripts/replay-agent-round.go) to separate harness bugs
// (fails only in-loop) from model-capability limits (fails one-shot too).
//
// SECURITY: the message list can contain user-pasted secrets. Capture is off by
// default; only enable it while debugging, point AGENT_DEBUG_CAPTURE_DIR at an
// access-restricted location, and clear it when done.
type agentDebugRound struct {
	RunID       string       `json:"runId"`
	Step        int          `json:"step"`  // the loop's step counter (UI-correlated)
	Round       int          `json:"round"` // monotonic per-Call index (unique within the run)
	Backend     string       `json:"backend"`
	Model       string       `json:"model"`
	Messages    []oaiMessage `json:"messages"`
	Tools       []oaiTool    `json:"tools,omitempty"`
	Temperature *float64     `json:"temperature,omitempty"`
	TopP        *float64     `json:"top_p,omitempty"`
	Seed        *int64       `json:"seed,omitempty"`
}

// captureAgentRound writes one inference round's exact payload to the debug
// capture dir as indented JSON. No-op unless cfg.agentDebugCapture is on. A
// log line names the file and the replay command so the operator can find and
// re-run a failing iteration without digging.
func (s *server) captureAgentRound(runID, backend, model string, step, round int, messages []oaiMessage, tools []oaiTool, sampling *agentSampling) {
	if !s.cfg.agentDebugCapture {
		return
	}
	dir := s.cfg.agentDebugCaptureDir
	if dir == "" {
		dir = "./agent-debug"
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		log.Printf("agent-debug capture: mkdir %s: %v", dir, err)
		return
	}
	rec := agentDebugRound{RunID: runID, Step: step, Round: round, Backend: backend, Model: model, Messages: messages, Tools: tools}
	if sampling != nil {
		t, p := sampling.temperature, sampling.topP
		rec.Temperature = &t
		rec.TopP = &p
		if sampling.seed != 0 {
			sd := sampling.seed
			rec.Seed = &sd
		}
	}
	b, _ := json.MarshalIndent(rec, "", "  ")
	name := fmt.Sprintf("agent-round-%s-r%d.json", runID, round)
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, b, 0o600); err != nil {
		log.Printf("agent-debug capture: write %s: %v", path, err)
		return
	}
	log.Printf("agent-debug capture: wrote %s (backend=%s model=%s step=%d msgs=%d tools=%d) — replay: go run scripts/replay-agent-round.go %s <ollama-url>", path, backend, model, step, len(messages), len(tools), path)
}

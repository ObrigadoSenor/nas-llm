//go:build ignore

// replay-agent-round replays a captured agent inference round against an
// Ollama /v1/chat/completions endpoint (non-streaming) and prints the raw
// assistant response — the "practical test" for separating harness bugs from
// model-capability limits. If the captured prompt fails one-shot too, it's a
// model-capability limit; if it only failed inside the loop, it's the harness
// (context bloat, formatting drift, or accumulated noise in history).
//
// Capture is produced by the backend when AGENT_DEBUG_CAPTURE=1; each round is
// written to AGENT_DEBUG_CAPTURE_DIR as agent-round-<runId>-r<round>.json.
//
// Usage:
//
//	go run scripts/replay-agent-round.go <round.json> <ollama-base-url>
//
// Example:
//
//	go run scripts/replay-agent-round.go ./agent-debug/agent-round-ab12cd34-r3.json http://localhost:11434
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

// req mirrors the request-relevant fields of backend/agent.go's agentDebugRound
// (plus stream). Messages/Tools are carried as RawMessage so the exact payload
// the backend sent is replayed byte-for-byte without redefining the Ollama
// message/tool schema here.
type req struct {
	Model       string          `json:"model"`
	Messages    json.RawMessage `json:"messages"`
	Tools       json.RawMessage `json:"tools,omitempty"`
	Stream      bool            `json:"stream"`
	Temperature *float64        `json:"temperature,omitempty"`
	TopP        *float64        `json:"top_p,omitempty"`
	Seed        *int64          `json:"seed,omitempty"`
}

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintf(os.Stderr, "usage: go run scripts/replay-agent-round.go <round.json> <ollama-base-url>\n")
		os.Exit(2)
	}
	path := os.Args[1]
	base := strings.TrimRight(os.Args[2], "/")

	raw, err := os.ReadFile(path)
	if err != nil {
		fmt.Fprintf(os.Stderr, "read %s: %v\n", path, err)
		os.Exit(1)
	}

	var r req
	if err := json.Unmarshal(raw, &r); err != nil {
		fmt.Fprintf(os.Stderr, "unmarshal capture: %v\n", err)
		os.Exit(1)
	}
	r.Stream = false // non-streaming so we get one assembled assistant message

	body, err := json.Marshal(&r)
	if err != nil {
		fmt.Fprintf(os.Stderr, "marshal request: %v\n", err)
		os.Exit(1)
	}

	url := base + "/v1/chat/completions"
	httpReq, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		fmt.Fprintf(os.Stderr, "build request: %v\n", err)
		os.Exit(1)
	}
	httpReq.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: 5 * time.Minute}
	resp, err := client.Do(httpReq)
	if err != nil {
		fmt.Fprintf(os.Stderr, "POST %s: %v\n", url, err)
		os.Exit(1)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		fmt.Fprintf(os.Stderr, "%s: HTTP %s\nbody: %s\n", url, resp.Status, string(respBody))
		os.Exit(1)
	}

	// Pretty-print so the assistant content + tool_calls are easy to read.
	var pretty bytes.Buffer
	if json.Indent(&pretty, respBody, "", "  ") == nil {
		fmt.Println(pretty.String())
	} else {
		fmt.Println(string(respBody))
	}
}

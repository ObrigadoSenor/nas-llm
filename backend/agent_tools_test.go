package main

import (
	"path/filepath"
	"testing"
)

// TestFileToolWiring guards the backend registration of the four direct file
// tools (write_file, edit_file, delete_path, move_path) across the three
// surfaces that must agree for them to be offered to a repo-bound agent run:
// the default allowlist (defaultAgentTools), the tool registry (which holds
// the schema the model sees, and the local-relay flag), and the UI-facing
// availableTools list. It also checks each schema is well-formed (local relay
// + its required args). Mirrors TestMergePrToolWiring's pattern: it prevents
// a silent wiring regression (e.g. a tool dropped from the allowlist) that
// would make the tool vanish without any other test failing. It does NOT
// exercise the sidecar executors — those run in the desktop app against a real
// repo and are covered by the Rust #[cfg(test)] module in github.rs.
func TestFileToolWiring(t *testing.T) {
	want := []struct {
		name    string
		require []string
	}{
		{"write_file", []string{"path", "content"}},
		{"edit_file", []string{"path", "old_string", "new_string"}},
		{"delete_path", []string{"path"}},
		{"move_path", []string{"from", "to"}},
	}
	defaults := defaultAgentTools()
	menu := availableTools(false)
	menuByName := map[string]bool{}
	for _, tm := range menu {
		menuByName[tm.Name] = true
	}
	st, err := newStore(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("newStore: %v", err)
	}
	defer st.close()
	srv := &server{cfg: config{contextLength: 8192}, store: st}
	reg := srv.toolRegistry("")
	for _, w := range want {
		if !slicesContains(defaults, w.name) {
			t.Errorf("defaultAgentTools() does not include %s", w.name)
		}
		if !menuByName[w.name] {
			t.Errorf("availableTools(false) does not include %s", w.name)
		}
		tool, ok := reg[w.name]
		if !ok {
			t.Errorf("toolRegistry does not register %s", w.name)
			continue
		}
		if tool.schema.Function.Name != w.name {
			t.Errorf("%s schema name = %q, want %s", w.name, tool.schema.Function.Name, w.name)
		}
		if !tool.local {
			t.Errorf("%s must be a local (sidecar-relayed) tool, got local=false", w.name)
		}
		req, _ := tool.schema.Function.Parameters["required"].([]string)
		for _, r := range w.require {
			found := false
			for _, got := range req {
				if got == r {
					found = true
					break
				}
			}
			if !found {
				t.Errorf("%s schema missing required %q arg: %v", w.name, r, req)
			}
		}
	}
}

// TestMergePrToolWiring guards the backend registration of the merge_pr agent
// tool across the three surfaces that must agree for it to be offered to a
// repo-bound agent run: the default allowlist (defaultAgentTools), the tool
// registry (which holds the schema the model sees), and the UI-facing
// availableTools list. It also checks the schema is well-formed (local relay,
// required "number").
//
// It does NOT exercise the sidecar executor (exec_merge_pr) or the GitHub merge
// API — those run in the desktop app with a real token and an open PR, which
// can't be driven from a Go test. This test prevents a silent wiring regression
// (e.g. merge_pr dropped from the allowlist) that would make the tool vanish
// without any other test failing.
func TestMergePrToolWiring(t *testing.T) {
	if !slicesContains(defaultAgentTools(), "merge_pr") {
		t.Errorf("defaultAgentTools() does not include merge_pr")
	}
	seenUI := false
	for _, tm := range availableTools(false) {
		if tm.Name == "merge_pr" {
			seenUI = true
			break
		}
	}
	if !seenUI {
		t.Errorf("availableTools(false) does not include merge_pr")
	}
	st, err := newStore(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("newStore: %v", err)
	}
	defer st.close()
	srv := &server{cfg: config{contextLength: 8192}, store: st}
	reg := srv.toolRegistry("")
	tool, ok := reg["merge_pr"]
	if !ok {
		t.Fatalf("toolRegistry does not register merge_pr")
	}
	if tool.schema.Function.Name != "merge_pr" {
		t.Errorf("merge_pr schema name = %q, want merge_pr", tool.schema.Function.Name)
	}
	if !tool.local {
		t.Error("merge_pr must be a local (sidecar-relayed) tool, got local=false")
	}
	req, _ := tool.schema.Function.Parameters["required"].([]string)
	hasNumber := false
	for _, r := range req {
		if r == "number" {
			hasNumber = true
		}
	}
	if !hasNumber {
		t.Errorf("merge_pr schema missing required \"number\" arg: %v", req)
	}
}

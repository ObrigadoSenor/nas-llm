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
	menu := availableTools(false, nil)
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
			t.Errorf("availableTools(false, nil) does not include %s", w.name)
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
	for _, tm := range availableTools(false, nil) {
		if tm.Name == "merge_pr" {
			seenUI = true
			break
		}
	}
	if !seenUI {
		t.Errorf("availableTools(false, nil) does not include merge_pr")
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

// TestTreeToolWiring guards the backend registration of the read-only tree
// agent tool across the four surfaces that must agree for it to be offered to a
// repo-bound agent run: the local repo tool list (localRepoTools), the default
// allowlist (defaultAgentTools, which appends localRepoTools), the tool registry
// (schema + local-relay flag), and the UI-facing availableTools list (which
// appends localToolMetas). Mirrors TestMergePrToolWiring's pattern: it prevents
// a silent wiring regression that would make tree vanish without any other test
// failing. The sidecar executor (exec_tree) is covered by the Rust #[cfg(test)]
// module in github.rs.
func TestTreeToolWiring(t *testing.T) {
	if !slicesContains(localRepoTools(), "tree") {
		t.Errorf("localRepoTools() does not include tree")
	}
	if !slicesContains(defaultAgentTools(), "tree") {
		t.Errorf("defaultAgentTools() does not include tree")
	}
	seenUI := false
	for _, tm := range availableTools(false, nil) {
		if tm.Name == "tree" {
			seenUI = true
			break
		}
	}
	if !seenUI {
		t.Errorf("availableTools(false, nil) does not include tree")
	}
	st, err := newStore(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("newStore: %v", err)
	}
	defer st.close()
	srv := &server{cfg: config{contextLength: 8192}, store: st}
	reg := srv.toolRegistry("")
	tool, ok := reg["tree"]
	if !ok {
		t.Fatalf("toolRegistry does not register tree")
	}
	if tool.schema.Function.Name != "tree" {
		t.Errorf("tree schema name = %q, want tree", tool.schema.Function.Name)
	}
	if !tool.local {
		t.Error("tree must be a local (sidecar-relayed) tool, got local=false")
	}
}

// TestSSHToolWiring guards the backend registration of the four ssh_* agent
// tools across the surfaces that must agree for them to be offered to an
// SSH-enabled agent run: sshTools (the ordered name list), the tool registry
// (schema + local-relay flag + host enum), and the UI-facing availableTools
// list (which gates them on the user's configured hosts). It confirms the host
// enum is populated from the user's aliases, that the tools are absent when the
// user has no hosts, and that they are never in defaultAgentTools (opt-in). It
// does NOT exercise the sidecar executor (the real ssh shell-out runs in the
// desktop app) — that is covered by the Rust #[cfg(test)] module in github.rs.
func TestSSHToolWiring(t *testing.T) {
	want := []struct {
		name    string
		require []string
	}{
		{"ssh_run", []string{"host", "command"}},
		{"ssh_read", []string{"host", "path"}},
		{"ssh_list", []string{"host"}},
		{"ssh_grep", []string{"host", "pattern"}},
	}
	// sshTools lists all four, in order.
	gotTools := sshTools()
	if len(gotTools) != len(want) {
		t.Fatalf("sshTools() = %v, want %d names", gotTools, len(want))
	}
	for i, w := range want {
		if gotTools[i] != w.name {
			t.Errorf("sshTools()[%d] = %q, want %q", i, gotTools[i], w.name)
		}
	}
	// ssh tools are NOT in defaultAgentTools (opt-in) and are NOT offered by
	// availableTools when the user has no hosts.
	for _, w := range want {
		if slicesContains(defaultAgentTools(), w.name) {
			t.Errorf("defaultAgentTools() must not include %s (ssh tools are opt-in)", w.name)
		}
	}
	for _, tm := range availableTools(false, nil) {
		if isSSHTool(tm.Name) {
			t.Errorf("availableTools(false, nil) offers %s with no hosts configured", tm.Name)
		}
	}
	// With hosts configured, availableTools offers all four ssh tools.
	menu := map[string]bool{}
	for _, tm := range availableTools(false, []string{"nas", "mac"}) {
		menu[tm.Name] = true
	}
	for _, w := range want {
		if !menu[w.name] {
			t.Errorf("availableTools(false, [nas,mac]) does not include %s", w.name)
		}
	}
	// toolRegistry registers the ssh tools with a host enum when the user has
	// hosts, and omits them when the user has none.
	st, err := newStore(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("newStore: %v", err)
	}
	defer st.close()
	const email = "ssh-user@example.com"
	if _, err := st.upsertSSHHost(email, "nas", "the NAS box"); err != nil {
		t.Fatalf("upsertSSHHost: %v", err)
	}
	srv := &server{cfg: config{contextLength: 8192}, store: st}
	reg := srv.toolRegistry(email)
	for _, w := range want {
		tool, ok := reg[w.name]
		if !ok {
			t.Errorf("toolRegistry does not register %s when a host is configured", w.name)
			continue
		}
		if tool.schema.Function.Name != w.name {
			t.Errorf("%s schema name = %q, want %s", w.name, tool.schema.Function.Name, w.name)
		}
		if !tool.local {
			t.Errorf("%s must be a local (sidecar-relayed) tool, got local=false", w.name)
		}
		// The host param must carry an enum containing the user's alias.
		props, _ := tool.schema.Function.Parameters["properties"].(map[string]any)
		hostProp, _ := props["host"].(map[string]any)
		enum, _ := hostProp["enum"].([]string)
		if !slicesContains(enum, "nas") {
			t.Errorf("%s host enum = %v, want to contain \"nas\"", w.name, enum)
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
	// A different user (no hosts) gets no ssh tools from the registry.
	reg2 := srv.toolRegistry("no-hosts@example.com")
	for _, w := range want {
		if _, ok := reg2[w.name]; ok {
			t.Errorf("toolRegistry registers %s for a user with no hosts", w.name)
		}
	}
}

// TestPrToolsWiring guards the backend registration of the seven PR agent tools
// added to round out the harness's GitHub PR support: pr_view, pr_diff,
// pr_checks (read-only) and pr_comment, pr_close, pr_ready, pr_edit
// (approval-gated, never auto-approved). For each it checks the surfaces that
// must agree for the tool to be offered to a repo-bound agent run: the default
// allowlist (defaultAgentTools), the tool registry (schema + local-relay flag +
// required args), the UI-facing availableTools list, and the localFileTools /
// localGitTools partition. It also asserts the plan-mode split: the four
// mutating tools are in planWriteTools (gated out pre-approval) while the three
// read-only ones are not. Mirrors TestMergePrToolWiring's membership style — it
// prevents a silent wiring regression that would make a tool vanish without any
// other test failing. It does NOT exercise the sidecar executors (exec_pr_*) or
// the GitHub API — those run in the desktop app with a real token and PR.
func TestPrToolsWiring(t *testing.T) {
	readOnly := []struct {
		name    string
		require []string
	}{
		{"pr_view", []string{"number"}},
		{"pr_diff", []string{"number"}},
		{"pr_checks", []string{"number"}},
	}
	mutating := []struct {
		name    string
		require []string
	}{
		{"pr_comment", []string{"number", "body"}},
		{"pr_close", []string{"number"}},
		{"pr_ready", []string{"number"}},
		{"pr_edit", []string{"number"}},
	}
	type want struct {
		name    string
		require []string
	}
	all := make([]want, 0, len(readOnly)+len(mutating))
	for _, w := range readOnly {
		all = append(all, want{w.name, w.require})
	}
	for _, w := range mutating {
		all = append(all, want{w.name, w.require})
	}

	defaults := defaultAgentTools()
	menuByName := map[string]bool{}
	for _, tm := range availableTools(false, nil) {
		menuByName[tm.Name] = true
	}
	st, err := newStore(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("newStore: %v", err)
	}
	defer st.close()
	srv := &server{cfg: config{contextLength: 8192}, store: st}
	reg := srv.toolRegistry("")

	// Every PR tool is a git tool: in localGitTools + localRepoTools, and
	// absent from localFileTools (a non-git workspace must not get them).
	for _, w := range all {
		if !slicesContains(localGitTools(), w.name) {
			t.Errorf("localGitTools() does not include %s", w.name)
		}
		if !slicesContains(localRepoTools(), w.name) {
			t.Errorf("localRepoTools() does not include %s", w.name)
		}
		if slicesContains(localFileTools(), w.name) {
			t.Errorf("localFileTools() must not include git-only tool %s", w.name)
		}
	}

	for _, w := range all {
		if !slicesContains(defaults, w.name) {
			t.Errorf("defaultAgentTools() does not include %s", w.name)
		}
		if !menuByName[w.name] {
			t.Errorf("availableTools(false, nil) does not include %s", w.name)
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

	// Plan-mode split: the four mutating PR tools are write tools (gated out
	// pre-approval); the three read-only ones are not.
	planWrite := map[string]bool{}
	for _, w := range planWriteTools() {
		planWrite[w] = true
	}
	for _, w := range mutating {
		if !planWrite[w.name] {
			t.Errorf("planWriteTools() does not include mutating PR tool %s", w.name)
		}
	}
	for _, w := range readOnly {
		if planWrite[w.name] {
			t.Errorf("planWriteTools() must not include read-only PR tool %s", w.name)
		}
	}
}

// TestRepoLifecycleToolsWiring guards the backend registration of the two
// repository-lifecycle agent tools: create_repo (create a new GitHub repo) and
// link_remote (add a GitHub origin remote to the local workspace). Both are
// approval-gated and external/mutating, so they must be in planWriteTools and
// must NOT be in localFileTools (a non-git workspace doesn't get them). It
// checks the surfaces that must agree for the tools to be offered to a
// repo-bound agent run: defaultAgentTools, toolRegistry (schema + local-relay
// flag + required args), availableTools, and the localGitTools partition. It
// does NOT exercise the sidecar executors or the GitHub API — those run in the
// desktop app with a real token.
func TestRepoLifecycleToolsWiring(t *testing.T) {
	want := []struct {
		name    string
		require []string
	}{
		{"create_repo", []string{"name"}},
		{"link_remote", []string{"url"}},
	}
	defaults := defaultAgentTools()
	menuByName := map[string]bool{}
	for _, tm := range availableTools(false, nil) {
		menuByName[tm.Name] = true
	}
	st, err := newStore(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("newStore: %v", err)
	}
	defer st.close()
	srv := &server{cfg: config{contextLength: 8192}, store: st}
	reg := srv.toolRegistry("")

	// Both are git-workflow tools: in localGitTools + localRepoTools, and
	// absent from localFileTools (a non-git workspace must not get them).
	for _, w := range want {
		if !slicesContains(localGitTools(), w.name) {
			t.Errorf("localGitTools() does not include %s", w.name)
		}
		if !slicesContains(localRepoTools(), w.name) {
			t.Errorf("localRepoTools() does not include %s", w.name)
		}
		if slicesContains(localFileTools(), w.name) {
			t.Errorf("localFileTools() must not include git-only tool %s", w.name)
		}
		if !slicesContains(defaults, w.name) {
			t.Errorf("defaultAgentTools() does not include %s", w.name)
		}
		if !menuByName[w.name] {
			t.Errorf("availableTools(false, nil) does not include %s", w.name)
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

	// Both are write tools for Plan-mode gating (gated out pre-approval).
	planWrite := map[string]bool{}
	for _, w := range planWriteTools() {
		planWrite[w] = true
	}
	for _, w := range want {
		if !planWrite[w.name] {
			t.Errorf("planWriteTools() does not include %s", w.name)
		}
	}
}

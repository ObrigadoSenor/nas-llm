package main

import (
	"path/filepath"
	"strings"
	"testing"
)

// TestUIToolWiring guards the backend registration of the four ui_* agent
// tools across the surfaces that must agree for them to be offered to a
// UI-enabled agent run: uiTools (the ordered name list), the tool registry
// (schema + local-relay flag + required args), and the UI-facing availableTools
// list. It also pins the opt-in contract: they must NOT be in
// defaultAgentTools, because enabling one makes the run browser-bound.
//
// It does NOT exercise the executors — those run in the page (www/ui.js)
// against a real DOM and are covered by the manual pass.
func TestUIToolWiring(t *testing.T) {
	want := []struct {
		name    string
		require []string
	}{
		{"ui_snapshot", nil}, // area is optional: a bare call snapshots everything
		{"ui_read", []string{"ref"}},
		{"ui_click", []string{"ref"}},
		{"ui_set_value", []string{"ref", "value"}},
	}
	got := uiTools()
	if len(got) != len(want) {
		t.Fatalf("uiTools() = %v, want %d names", got, len(want))
	}
	for i, w := range want {
		if got[i] != w.name {
			t.Errorf("uiTools()[%d] = %q, want %q", i, got[i], w.name)
		}
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

	for _, w := range want {
		// Opt-in: never in the defaults (unlike the repo file tools).
		if slicesContains(defaults, w.name) {
			t.Errorf("defaultAgentTools() includes %s \u2014 ui_* tools are opt-in (they make a run browser-bound)", w.name)
		}
		// But always in the menu, so the user can turn them on: unlike ssh_*,
		// they have no precondition to check (the page is always there).
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
			t.Errorf("%s must be a local (relayed) tool, got local=false", w.name)
		}
		if tool.execute != nil {
			t.Errorf("%s must have no server-side executor \u2014 the page runs it", w.name)
		}
		req, _ := tool.schema.Function.Parameters["required"].([]string)
		for _, r := range w.require {
			found := false
			for _, g := range req {
				if g == r {
					found = true
					break
				}
			}
			if !found {
				t.Errorf("%s schema missing required %q arg: %v", w.name, r, req)
			}
		}
	}

	// ui_* tools are their own family: they must not leak into the repo tool
	// lists, or a repo-bound run would silently gain them without the user
	// opting in (and without the UI prompt block, which is gated separately).
	for _, w := range want {
		if slicesContains(localRepoTools(), w.name) {
			t.Errorf("localRepoTools() must not include %s", w.name)
		}
		if slicesContains(localFileTools(), w.name) {
			t.Errorf("localFileTools() must not include %s", w.name)
		}
	}
}

// TestContainsAnyUITool covers the predicate that drives both the toolExec
// relay (a UI-enabled run needs one even with no repo bound) and
// agentRunNeedsBrowser.
func TestContainsAnyUITool(t *testing.T) {
	if containsAnyUITool(defaultAgentTools()) {
		t.Error("defaultAgentTools() contains a ui_* tool \u2014 they are opt-in")
	}
	if containsAnyUITool([]string{"web_search", "read_file", "ssh_run"}) {
		t.Error("containsAnyUITool matched a non-UI allowlist")
	}
	if !containsAnyUITool([]string{"web_search", "ui_snapshot"}) {
		t.Error("containsAnyUITool missed ui_snapshot")
	}
	if !isUITool("ui_click") || isUITool("read_file") {
		t.Error("isUITool misclassified a tool name")
	}
}

// TestUITargetStamp checks the toolExec payload seam: a ui_* tool is stamped
// with the app target so the renderer can route it, and every other tool is
// left blank (repo/ssh tools route on repo/host instead).
func TestUITargetStamp(t *testing.T) {
	for _, name := range uiTools() {
		if got := uiTargetFor(name); got != uiTargetApp {
			t.Errorf("uiTargetFor(%s) = %q, want %q", name, got, uiTargetApp)
		}
	}
	for _, name := range []string{"read_file", "run_command", "ssh_run", "web_search"} {
		if got := uiTargetFor(name); got != "" {
			t.Errorf("uiTargetFor(%s) = %q, want empty", name, got)
		}
	}
}

// TestUIActionToolsPlanGated guards the Plan-mode split for the UI family: the
// two action tools are write tools (gated out before the plan is approved) so
// a plan-mode run can look at the interface but not drive it, while the two
// read tools survive the filter.
func TestUIActionToolsPlanGated(t *testing.T) {
	planWrite := map[string]bool{}
	for _, w := range planWriteTools() {
		planWrite[w] = true
	}
	for _, name := range []string{"ui_click", "ui_set_value"} {
		if !planWrite[name] {
			t.Errorf("planWriteTools() does not include UI action tool %s", name)
		}
	}
	for _, name := range []string{"ui_snapshot", "ui_read"} {
		if planWrite[name] {
			t.Errorf("planWriteTools() must not include read-only UI tool %s", name)
		}
	}
	filtered := filterPlanWriteTools(append([]string{}, uiTools()...))
	if slicesContains(filtered, "ui_click") || slicesContains(filtered, "ui_set_value") {
		t.Errorf("filterPlanWriteTools left a UI action tool in the allowlist: %v", filtered)
	}
	for _, name := range []string{"ui_snapshot", "ui_read"} {
		if !slicesContains(filtered, name) {
			t.Errorf("filterPlanWriteTools dropped read-only UI tool %s", name)
		}
	}
}

// TestAgentRunNeedsBrowserForUITools covers the job-lifecycle consequence of
// enabling the UI family: the run relays through the page, so it is
// connection-bound and gets the grace-period cancel. A non-UI allowlist with no
// repo and no SSH hosts stays detached, exactly as before.
func TestAgentRunNeedsBrowserForUITools(t *testing.T) {
	st, err := newStore(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("newStore: %v", err)
	}
	defer st.close()
	srv := &server{cfg: config{contextLength: 8192}, store: st}
	const email = "ui@example.com"

	if err := st.setSetting("agent_tools", "web_search,get_time"); err != nil {
		t.Fatalf("setSetting: %v", err)
	}
	if srv.agentRunNeedsBrowser(email, "conv-1", "") {
		t.Error("a non-repo, non-UI, non-SSH agent run must stay detached")
	}
	if err := st.setSetting("agent_tools", "web_search,ui_snapshot"); err != nil {
		t.Fatalf("setSetting: %v", err)
	}
	if !srv.agentRunNeedsBrowser(email, "conv-1", "") {
		t.Error("a UI-enabled agent run must be browser-bound (the page executes ui_*)")
	}
}

// TestFilterRepoToolsForUIOnlyRun guards the allowlist for a run that has a
// toolExec relay but no workspace — which is new: the relay used to imply a
// repo. The repo/file/git/todo tools must be dropped (nothing can execute
// them: the sidecar errors on an empty repo and the browser UI ignores them
// entirely, stalling the run until TOOL_EXEC_TIMEOUT), while the ui_*, ssh_*
// and server-side tools survive.
func TestFilterRepoToolsForUIOnlyRun(t *testing.T) {
	allow := append(defaultAgentTools(), uiTools()...)
	allow = append(allow, sshTools()...)
	filtered := filterRepoTools(append([]string{}, allow...))
	for _, name := range localRepoTools() {
		if slicesContains(filtered, name) {
			t.Errorf("filterRepoTools left repo tool %s in a workspace-less run", name)
		}
	}
	for _, name := range append(append([]string{}, uiTools()...), "ssh_run", "web_search", "ask_user", "get_time") {
		if !slicesContains(filtered, name) {
			t.Errorf("filterRepoTools dropped %s, which does not need a workspace", name)
		}
	}
}

// TestValidateToolArgsNoRequiredArgs covers the argument validation a bare
// ui_snapshot depends on. Models emit "" as often as "{}" for a no-argument
// call; rejecting "" spent a step of the budget rebuking a perfectly valid
// call. A tool that genuinely requires arguments still rejects both.
func TestValidateToolArgsNoRequiredArgs(t *testing.T) {
	snapshot := agentTool{schema: uiSnapshotTool()}
	click := agentTool{schema: uiClickTool()}
	for _, args := range []string{"", "  ", "{}"} {
		if err := validateToolArgs(snapshot, args); err != nil {
			t.Errorf("validateToolArgs(ui_snapshot, %q) = %v, want nil", args, err)
		}
	}
	if err := validateToolArgs(click, ""); err == nil {
		t.Error("validateToolArgs(ui_click, \"\") = nil, want an error (ref is required)")
	}
	if err := validateToolArgs(click, "{}"); err == nil {
		t.Error("validateToolArgs(ui_click, \"{}\") = nil, want a missing-ref error")
	}
	if err := validateToolArgs(click, `{"ref":"#modelBtn"}`); err != nil {
		t.Errorf("validateToolArgs(ui_click, valid) = %v, want nil", err)
	}
}

// TestInjectUIContext checks the UI-awareness prompt block: it appends to the
// base prompt (so it composes with the repo/workspace/plan blocks, which
// prepend), names the tools, forbids the disclaimer this whole feature exists
// to kill, warns that refs go stale, and tells the model to look up meaning in
// the source rather than inventing it from a bare number.
func TestInjectUIContext(t *testing.T) {
	out := injectUIContext("BASE")
	if !strings.HasPrefix(out, "BASE") {
		t.Error("injectUIContext must append to the base prompt, not prepend")
	}
	if !strings.Contains(out, "cannot see the interface") {
		t.Error("injectUIContext does not forbid the \"cannot see the interface\" disclaimer")
	}
	for _, tool := range uiTools() {
		if !strings.Contains(out, tool) {
			t.Errorf("injectUIContext does not name %s", tool)
		}
	}
	if !strings.Contains(out, "stale") {
		t.Error("injectUIContext does not warn that refs go stale")
	}
	if !strings.Contains(out, "grep") {
		t.Error("injectUIContext does not steer the model to the source for meaning")
	}
}

package main

import (
	"path/filepath"
	"strings"
	"testing"
)

// TestLocalToolPartition guards the file/git split of localRepoTools: a git
// workspace gets the full set (file + git), a non-git workspace's
// localFileTools must contain every file tool and none of the git tools, and
// the union of localFileTools + localGitTools must equal localRepoTools (so
// the git-repo path is unchanged). Mirrors the membership-only style of
// agent_tools_test.go: it prevents a silent regression where a git tool leaks
// into a non-git workspace (or a file tool is dropped from it).
func TestLocalToolPartition(t *testing.T) {
	file := localFileTools()
	git := localGitTools()
	all := localRepoTools()

	fileSet := map[string]bool{}
	for _, name := range file {
		fileSet[name] = true
	}
	for _, name := range git {
		if fileSet[name] {
			t.Errorf("%q appears in both localFileTools and localGitTools", name)
		}
	}
	// Every git tool must be absent from the file-only set.
	for _, name := range git {
		if !slicesContains(all, name) {
			t.Errorf("localRepoTools() does not include git tool %s", name)
		}
	}
	// Every file tool must be in the full set.
	for _, name := range file {
		if !slicesContains(all, name) {
			t.Errorf("localRepoTools() does not include file tool %s", name)
		}
	}
	// The file set must not contain any git tool.
	for _, name := range git {
		if fileSet[name] {
			t.Errorf("localFileTools() must not include git tool %s", name)
		}
	}
	// Specifically: the git workflow tools are gated out of a non-git workspace.
	wantGit := []string{"git_status", "git_log", "list_prs", "git_commit", "git_push", "create_pr", "merge_pr", "pr_view", "pr_diff", "pr_checks", "pr_comment", "pr_close", "pr_ready", "pr_edit", "create_repo", "link_remote"}
	for _, name := range wantGit {
		if fileSet[name] {
			t.Errorf("localFileTools() includes git-only tool %s (should be gated for non-git)", name)
		}
		if !slicesContains(git, name) {
			t.Errorf("localGitTools() missing %s", name)
		}
	}
	// The file tools a non-git workspace needs are present, plus the Tasks Pill
	// tools (todo_write/todo_read) which are workspace-agnostic local tools.
	wantFile := []string{"read_file", "list_files", "tree", "glob", "grep", "write_file", "edit_file", "move_path", "delete_path", "apply_patch", "run_command", "todo_write", "todo_read"}
	for _, name := range wantFile {
		if !fileSet[name] {
			t.Errorf("localFileTools() missing file tool %s", name)
		}
	}
	// The Tasks Pill tools are in the full repo set too.
	for _, name := range []string{"todo_write", "todo_read"} {
		if !slicesContains(all, name) {
			t.Errorf("localRepoTools() does not include tasks tool %s", name)
		}
	}
}

// TestInjectWorkspaceContext checks the non-git workspace system-prompt block:
// it names the workspace, says (no git), lists the tree, forbids the git
// tools, and preserves the .env-secret rule — and it must NOT mention branch,
// HEAD, worktree, or gitignore (those are git-only concepts).
func TestInjectWorkspaceContext(t *testing.T) {
	repo := &Repo{FullName: "notes", Name: "notes", UseGit: false, Tree: []string{"README.md", "drafts/"}}
	out := injectWorkspaceContext("BASE", repo)
	if !strings.Contains(out, "notes") {
		t.Error("injectWorkspaceContext does not name the workspace")
	}
	if !strings.Contains(out, "(no git)") {
		t.Error("injectWorkspaceContext does not state the workspace has no git")
	}
	if !strings.Contains(out, "README.md") || !strings.Contains(out, "drafts/") {
		t.Error("injectWorkspaceContext does not list the top-level tree")
	}
	for _, git := range []string{"git_status", "git_log", "git_commit", "git_push", "create_pr", "list_prs", "merge_pr", "pr_view", "pr_diff", "pr_checks", "pr_comment", "pr_close", "pr_ready", "pr_edit", "create_repo", "link_remote"} {
		if !strings.Contains(out, git) {
			t.Errorf("injectWorkspaceContext does not forbid git tool %s", git)
		}
	}
	if !strings.Contains(out, ".env") || !strings.Contains(out, "NEVER") {
		t.Error("injectWorkspaceContext lost the .env-secret rule")
	}
	for _, gitOnly := range []string{"branch", "HEAD", "worktree", "gitignore"} {
		if strings.Contains(out, gitOnly) {
			t.Errorf("injectWorkspaceContext mentions git-only concept %q (should be git-repo only)", gitOnly)
		}
	}
	if !strings.Contains(out, "BASE") {
		t.Error("injectWorkspaceContext does not append the base system prompt")
	}
}

// TestRepoUseGitRoundTrip exercises the store round-trip for the UseGit + Name
// fields: a non-git workspace saved and re-read keeps UseGit=false and its
// display name, while a git repo keeps UseGit=true. Guards against a migration
// or column regression that would silently flip every workspace to git-enabled.
func TestRepoUseGitRoundTrip(t *testing.T) {
	st, err := newStore(":memory:")
	if err != nil {
		// newStore prefers a path; fall back to a temp file if :memory: isn't
		// honored by the sqlite driver config in this build.
		st, err = newStore(filepath.Join(t.TempDir(), "ws.db"))
		if err != nil {
			t.Fatalf("newStore: %v", err)
		}
	}
	defer st.close()
	const email = "ws@example.com"

	ws, err := st.upsertRepo(email, &Repo{FullName: "scratch", Name: "scratch", UseGit: false, Tree: []string{"a.txt"}})
	if err != nil {
		t.Fatalf("upsertRepo non-git: %v", err)
	}
	if ws.UseGit {
		t.Error("non-git workspace came back UseGit=true")
	}
	if ws.Name != "scratch" {
		t.Errorf("non-git workspace Name = %q, want scratch", ws.Name)
	}
	got, err := st.getRepo(email, ws.ID)
	if err != nil || got == nil {
		t.Fatalf("getRepo: %v", err)
	}
	if got.UseGit {
		t.Error("getRepo returned UseGit=true for a non-git workspace")
	}
	if got.Name != "scratch" {
		t.Errorf("getRepo Name = %q, want scratch", got.Name)
	}

	gr, err := st.upsertRepo(email, &Repo{FullName: "owner/repo", UseGit: true, Tree: []string{"src/"}})
	if err != nil {
		t.Fatalf("upsertRepo git: %v", err)
	}
	if !gr.UseGit {
		t.Error("git repo came back UseGit=false")
	}
	// listRepos must surface both with their flags.
	list, err := st.listRepos(email)
	if err != nil {
		t.Fatalf("listRepos: %v", err)
	}
	var sawGit, sawNonGit bool
	for _, r := range list {
		if r.FullName == "owner/repo" && r.UseGit {
			sawGit = true
		}
		if r.FullName == "scratch" && !r.UseGit {
			sawNonGit = true
		}
	}
	if !sawGit {
		t.Error("listRepos did not return the git repo as UseGit=true")
	}
	if !sawNonGit {
		t.Error("listRepos did not return the non-git workspace as UseGit=false")
	}
}

// TestTodosPlanRoundTrip exercises the store round-trip for the Tasks Pill
// (todos) and Plan mode (planMode/plan/planApproved) fields: PATCH them onto a
// conversation and confirm getConversation + listConversations read them back.
// Guards against a migration or column regression that would silently drop
// the Tasks Pill or Plan mode state.
func TestTodosPlanRoundTrip(t *testing.T) {
	st, err := newStore(":memory:")
	if err != nil {
		st, err = newStore(filepath.Join(t.TempDir(), "ws.db"))
		if err != nil {
			t.Fatalf("newStore: %v", err)
		}
	}
	defer st.close()
	const email = "ws@example.com"
	c, err := st.createConversation(email, "conv-todos", "t", "local:1b", nil)
	if err != nil {
		t.Fatalf("createConversation: %v", err)
	}
	todos := []Todo{{Text: "Read main.go", Status: "completed"}, {Text: "Edit lib.ts", Status: "in_progress"}}
	plan := "1. Read. 2. Edit. 3. Test."
	planMode := true
	if _, err := st.patchConversation(email, c.ID, nil, nil, nil, nil, nil, nil, nil, nil, &todos, &plan, &planMode, nil); err != nil {
		t.Fatalf("patchConversation: %v", err)
	}
	got, err := st.getConversation(email, c.ID)
	if err != nil || got == nil {
		t.Fatalf("getConversation: %v", err)
	}
	if len(got.Todos) != 2 || got.Todos[0].Text != "Read main.go" || got.Todos[1].Status != "in_progress" {
		t.Errorf("todos round-trip = %+v, want 2 items", got.Todos)
	}
	if got.Plan != plan || !got.PlanMode {
		t.Errorf("plan/planMode round-trip: plan=%q planMode=%v", got.Plan, got.PlanMode)
	}
	// listConversations must surface todos + planMode too.
	list, err := st.listConversations(email)
	if err != nil {
		t.Fatalf("listConversations: %v", err)
	}
	var sawTodos bool
	for _, lc := range list {
		if lc.ID == c.ID && len(lc.Todos) == 2 && lc.PlanMode {
			sawTodos = true
		}
	}
	if !sawTodos {
		t.Error("listConversations did not surface todos/planMode")
	}
}

// TestFilterPlanWriteTools guards the Plan-mode write-tool gate: filtering
// removes every planWriteTools entry (write + git-workflow tools) and leaves
// the read-only + planning tools (read_file, grep, todo_write, ask_user, …).
// Guards against a regression that would let a pre-approval plan-mode run edit.
func TestFilterPlanWriteTools(t *testing.T) {
	allow := defaultAgentTools()
	allow = append(allow, localRepoTools()...)
	filtered := filterPlanWriteTools(append([]string{}, allow...))
	write := planWriteTools()
	writeSet := map[string]bool{}
	for _, w := range write {
		writeSet[w] = true
	}
	for _, t2 := range filtered {
		if writeSet[t2] {
			t.Errorf("filterPlanWriteTools left a write tool %s in the allowlist", t2)
		}
	}
	// The read-only + planning tools must survive.
	for _, keep := range []string{"read_file", "grep", "tree", "ask_user", "get_time", "todo_write", "todo_read", "web_search"} {
		if !slicesContains(filtered, keep) {
			t.Errorf("filterPlanWriteTools dropped a read/planning tool %s", keep)
		}
	}
}

// TestInjectPlanContext checks the Plan-mode system-prompt block: it names
// plan mode, forbids editing pre-approval (or says approved post-approval),
// and includes the plan text. Pre-approval must NOT say "implement".
func TestInjectPlanContext(t *testing.T) {
	pre := injectPlanContext("BASE", "a plan", false)
	if !strings.Contains(pre, "PLAN MODE") {
		t.Error("injectPlanContext (pre-approval) does not name plan mode")
	}
	if !strings.Contains(pre, "DO NOT edit") {
		t.Error("injectPlanContext (pre-approval) does not forbid editing")
	}
	if strings.Contains(pre, "Implement it now") {
		t.Error("injectPlanContext (pre-approval) says implement")
	}
	if !strings.Contains(pre, "a plan") {
		t.Error("injectPlanContext (pre-approval) does not include the plan text")
	}
	post := injectPlanContext("BASE", "a plan", true)
	if !strings.Contains(post, "Implement it now") {
		t.Error("injectPlanContext (post-approval) does not say implement")
	}
	if strings.Contains(post, "PLAN MODE") {
		t.Error("injectPlanContext (post-approval) still says PLAN MODE")
	}
}

// TestTodoToolsRegistered guards the todo_write/todo_read tool wiring: both
// are local (sidecar-relayed) tools in the registry and appear in availableTools
// so the UI can list them. Mirrors TestFileToolWiring's membership style.
func TestTodoToolsRegistered(t *testing.T) {
	if !slicesContains(localRepoTools(), "todo_write") || !slicesContains(localRepoTools(), "todo_read") {
		t.Error("localRepoTools() does not include todo_write/todo_read")
	}
	seenUI := map[string]bool{}
	for _, tm := range availableTools(false, nil) {
		seenUI[tm.Name] = true
	}
	for _, name := range []string{"todo_write", "todo_read"} {
		if !seenUI[name] {
			t.Errorf("availableTools does not include %s", name)
		}
	}
	st, err := newStore(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("newStore: %v", err)
	}
	defer st.close()
	srv := &server{cfg: config{contextLength: 8192}, store: st}
	reg := srv.toolRegistry("")
	for _, name := range []string{"todo_write", "todo_read"} {
		tool, ok := reg[name]
		if !ok {
			t.Errorf("toolRegistry does not register %s", name)
			continue
		}
		if !tool.local {
			t.Errorf("%s must be a local (sidecar-relayed) tool, got local=false", name)
		}
		if tool.schema.Function.Name != name {
			t.Errorf("%s schema name = %q, want %s", name, tool.schema.Function.Name, name)
		}
	}
}

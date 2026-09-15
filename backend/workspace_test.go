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
	wantGit := []string{"git_status", "git_log", "list_prs", "git_commit", "git_push", "create_pr", "merge_pr"}
	for _, name := range wantGit {
		if fileSet[name] {
			t.Errorf("localFileTools() includes git-only tool %s (should be gated for non-git)", name)
		}
		if !slicesContains(git, name) {
			t.Errorf("localGitTools() missing %s", name)
		}
	}
	// The file tools a non-git workspace needs are present.
	wantFile := []string{"read_file", "list_files", "tree", "glob", "grep", "write_file", "edit_file", "move_path", "delete_path", "apply_patch", "run_command"}
	for _, name := range wantFile {
		if !fileSet[name] {
			t.Errorf("localFileTools() missing file tool %s", name)
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
	for _, git := range []string{"git_status", "git_log", "git_commit", "git_push", "create_pr", "list_prs", "merge_pr"} {
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

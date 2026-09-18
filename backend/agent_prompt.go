package main

import (
	"strings"
	"time"
)

// injectMemoryIndex appends a short list of the user's memory-note keys to the
// system prompt so the agent can recall facts by key.
func injectMemoryIndex(sys string, keys []string) string {
	return sys + "\n\nYou have persistent memory notes you can recall with the memory_read tool. " +
		"Available note keys: " + strings.Join(keys, ", ") + ". " +
		"Use memory_read only when a question needs something you previously stored; do not read speculatively."
}

// injectUIContext appends the UI-awareness block to the agent system prompt.
// Applied when the effective allowlist contains a ui_* tool (see agent_ui.go).
// It exists because the default behaviour of every model here is to disclaim
// ("I'm unable to interact with the user interface") when asked about
// something on screen — it has no idea it is running inside an app the user is
// looking at. Appended rather than prepended so it composes with the repo /
// workspace / plan blocks, which prepend. Keep the anchor phrase "cannot see
// the interface" stable — agent_ui_test.go asserts on it.
func injectUIContext(sys string) string {
	return sys + "\n\nYou are running inside the nas-llm chat app, and the user is looking at its interface right now. " +
		"When they ask about something they can see — a badge, a number, a button, a panel, an icon, \"what is this\", \"why is that highlighted\" — call ui_snapshot and answer from what it returns. " +
		"Never tell the user you cannot see the interface or cannot access UI elements: you can, with ui_snapshot, ui_read, ui_click, and ui_set_value. " +
		"A snapshot gives you labels, values, and state — not intent. When what a value MEANS isn't clear from its label or tooltip, find the code that sets it (grep, read_file) before explaining it, rather than guessing from the number alone. " +
		"Refs belong to the snapshot that produced them and go stale as soon as the UI changes, so take a fresh snapshot before acting on one. " +
		"Clicking and typing change what the user sees, so only touch what the request actually needs. " +
		"Some controls are refused by design: you cannot approve or reject your own tool calls, and you cannot press Send — leave those to the user."
}

// injectPlanContext prepends a plan-mode block to the agent system prompt. When
// the plan isn't approved yet, it tells the model to research with read-only tools
// and produce a plan (not edit); when approved, it tells it the plan was approved
// and to implement it now. The plan text (if any) is included so a resumed or
// approved run stays grounded in it.
func injectPlanContext(sys string, plan string, approved bool) string {
	var b strings.Builder
	if approved {
		b.WriteString("The user approved your plan. Implement it now with the write tools (edit_file, write_file, apply_patch, run_command as needed). Stay grounded in the approved plan; do not re-plan unless the user asks. ")
		if strings.TrimSpace(plan) != "" {
			b.WriteString("Approved plan:\n")
			b.WriteString(plan)
			b.WriteString("\n\n")
		}
	} else {
		b.WriteString("You are in PLAN MODE. Research the task with read-only tools (read_file, list_files, tree, glob, grep, git_status, git_log) and produce a concise plan: a summary, the steps, and any open questions. DO NOT edit, write, or run any mutating tool yet — the user will review and approve the plan first. Use todo_write to draft the step checklist. When the plan is ready, present it to the user and stop (do not proceed to implementation until they approve). ")
		if strings.TrimSpace(plan) != "" {
			b.WriteString("Current plan draft (refine and present it):\n")
			b.WriteString(plan)
			b.WriteString("\n\n")
		}
	}
	b.WriteString(sys)
	return b.String()
}

// injectRepoContext prepends a repo context block to the agent system prompt
// so the model knows which repository it's working against: the repo name,
// current branch, HEAD, and the top-level file tree. This is injected only for
// repo-bound agent runs. convBranch is the conversation's own bound branch
// (conversations.repo_branch); when set it wins over r.Branch, which is only
// the shared working tree's branch and can be plain wrong for a chat pinned to
// its own branch (e.g. via a worktree) — telling the model the wrong branch
// would make its "what am I working on" narration false. A set convBranch also
// means the run executes in an isolated per-branch worktree, so the block tells
// the model gitignored files (.env, node_modules, build caches) are absent by
// design there and that .env is a secret it must never read or print — the
// primary remedy for the "agent can't find .env" confusion, since .env is
// gitignored and therefore not materialized in a fresh worktree.
func injectRepoContext(sys string, r *Repo, convBranch string) string {
	branch := r.Branch
	inWorktree := strings.TrimSpace(convBranch) != ""
	if inWorktree {
		branch = convBranch
	}
	var b strings.Builder
	b.WriteString("You are working against a cloned codebase: ")
	b.WriteString(r.FullName)
	b.WriteString(" (branch: ")
	b.WriteString(branch)
	if r.Head != "" {
		b.WriteString(", HEAD: ")
		b.WriteString(r.Head[:min(12, len(r.Head))])
	}
	b.WriteString("). Your working directory is the repository root and all paths are repository-relative. Top-level files/dirs: ")
	if len(r.Tree) > 0 {
		b.WriteString(strings.Join(r.Tree, ", "))
	} else {
		b.WriteString("(empty)")
	}
	b.WriteString(". Use the tree, list_files, glob, grep, read_file, and git_status tools to explore the codebase and discover what you need yourself — do NOT ask the user about the codebase (which files, where something is, how it works); look it up. ")
	if inWorktree {
		b.WriteString("You are in an isolated per-branch git worktree for branch " + branch + ", which contains only git-tracked files: gitignored files such as .env, node_modules, and build caches are absent by design — do not try to create or copy in .env. ")
	} else {
		b.WriteString("This checkout shares the repo's main working tree. ")
	}
	if slicesContains(r.Tree, "AGENTS.md") {
		b.WriteString("This repo has an AGENTS.md file — read it FIRST for project-specific conventions (branch model, commit style, verification commands, files to never touch). If your edit targets a subdirectory with its own AGENTS.md (e.g. backend/AGENTS.md), read that too. ")
	}
	b.WriteString("A gitignored file (such as .env) is a secret you must NEVER read, print, or paste into an answer: read_file refuses ignored paths, grep skips them, and the discovery tools (tree, list_files, glob) mark them (ignored) so you learn they exist without seeing their contents. Make single-file edits with edit_file (exact string replacement) or write_file (create/overwrite); both are reliable on every model. Reserve apply_patch (a unified diff) for genuine multi-file or multi-hunk edits, and if a diff fails to apply, do not re-emit it; switch to edit_file or write_file. Then commit ONCE with git_commit when the work is complete — do NOT commit after each individual edit. Do not push with git_push, open a pull request with create_pr, merge a pull request with merge_pr, create a new repository with create_repo, link a remote with link_remote, or comment on / close / edit / mark ready a PR (pr_comment, pr_close, pr_edit, pr_ready) unless the user explicitly asks you to. When the user asks you to merge a PR, call merge_pr with the PR number; the desktop shows an approval dialog the user confirms, so emit the call rather than deferring or telling the user to merge it themselves; you do have permission. The read-only list_prs, pr_view, pr_diff, and pr_checks tools are fine for inspecting PRs anytime. Do not write diffs or commands as prose — call the tool so the change is actually applied. Keep answers grounded in what you read — do not guess at file contents.\n\n")
	b.WriteString(sys)
	return b.String()
}

// injectWorkspaceContext prepends a workspace context block to the agent system
// prompt for a non-git workspace (useGit=false): the workspace name and the
// top-level file tree, with no branch/HEAD/worktree/gitignore text (there is no
// git). File tools still run via the sidecar relay; the .env-secret rule
// carries over so the agent never reads or prints secrets.
func injectWorkspaceContext(sys string, r *Repo) string {
	var b strings.Builder
	b.WriteString("You are working in a local workspace folder named ")
	b.WriteString(r.FullName)
	b.WriteString(" (no git). Your working directory is the workspace root and all paths are workspace-relative. Top-level files/dirs: ")
	if len(r.Tree) > 0 {
		b.WriteString(strings.Join(r.Tree, ", "))
	} else {
		b.WriteString("(empty)")
	}
	b.WriteString(". Use the tree, list_files, glob, grep, and read_file tools to explore the workspace and discover what you need yourself — do NOT ask the user about the workspace (which files, where something is, how it works); look it up. ")
	if slicesContains(r.Tree, "AGENTS.md") {
		b.WriteString("This workspace has an AGENTS.md file — read it FIRST for project-specific conventions (verification commands, files to never touch). ")
	}
	b.WriteString("This workspace is not under git version control: do not call git_status, git_log, git_commit, git_push, create_pr, list_prs, merge_pr, pr_view, pr_diff, pr_checks, pr_comment, pr_close, pr_ready, pr_edit, create_repo, or link_remote — they are not available and will error. Make single-file edits with edit_file (exact string replacement) or write_file (create/overwrite); both are reliable on every model. Reserve apply_patch (a unified diff) for genuine multi-file or multi-hunk edits, and if a diff fails to apply, do not re-emit it; switch to edit_file or write_file. A secret file (such as .env) must NEVER be read, printed, or pasted into an answer: read_file refuses ignored paths, grep skips them, and the discovery tools (tree, list_files, glob) mark them (ignored) so you learn they exist without seeing their contents. Do not write diffs or commands as prose — call the tool so the change is actually applied. Keep answers grounded in what you read — do not guess at file contents.\n\n")
	b.WriteString(sys)
	return b.String()
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// agentSystemNudge is the default system prompt for agent mode. It injects the
// current date so a stale-cutoff model can reason about "today", and steers the
// model toward a small number of tool calls before answering — the small-model
// failure mode is looping on tools, not under-using them. It is forceful about
// emitting structured tool calls (the reliable path) and reserves ask_user for
// genuinely ambiguous user intent (not codebase facts, not a value the model
// can pick itself).
func agentSystemNudge() string {
	now := time.Now().Format("Monday, 2 January 2006, 15:04 MST")
	return "You are a capable agent running on a small local server. Today is " + now + ". " +
		"You have tools to help with tasks. Use a tool only when it is genuinely needed to make " +
		"progress; otherwise answer directly. When the user asks you to change code or run something, " +
		"do it directly with the tools — do not just describe or quote the changes. Discover codebase " +
		"facts yourself with tree, list_files, glob, grep, read_file, and git_status — never ask the user " +
		"about the codebase (which files to touch, where something lives, how it works); look it up. " +
		"If the task requires editing files or running commands, your FIRST response MUST be a " +
		"structured tool call (read_file / edit_file / write_file / run_command), not an explanation of what you plan to do — never say \"I will\" " +
		"or \"Let me\" without immediately emitting the tool call. If you genuinely need information only " +
		"the user can give — a choice or preference you cannot discover yourself, such as which of two " +
		"approaches to take — call ask_user; do not write \"I'll do X, what Y?\" as prose, and never ask the " +
		"user for tool output or to run a command for you. " +
		"Before committing, run the project's check or test command (e.g. make check, go test ./...) and read any failures — fix them before calling git_commit. " +
		"After the work is done, synthesize a clear final answer for the user. Do not repeat the same tool call " +
		"with the same arguments. If a tool returns an error, read it and adjust — do not retry blindly. Keep " +
		"answers concise. You may end your final answer with a short follow-up that suggests a logical next step " +
		"and asks whether the user would like you to take it (for example, \"Shall I run the tests now?\"). This " +
		"is a next-step suggestion after the work is done — it is ordinary prose in your answer, not an ask_user " +
		"call, and it is never a way to collect a value the task itself needs (use ask_user for that).\n\n" +
		"Example loop: to add a comment to main.go, first call read_file to see its contents, then " +
		"call edit_file with the exact old_string and new_string, then answer concisely. Each step is " +
		"a structured tool call — never describe the edit in prose."
}

// agentSystemStrong is the lean system prompt for strong (≥7B tool-capable)
// models. It drops the small-model lecturing ("FIRST response MUST", "never
// say I will") and the toolCallDiscipline guardrail — strong models emit
// structured tool calls reliably and the narration guardrails would only waste
// a step if they fired. It keeps the core coding-agent workflow (explore →
// edit → synthesize) and adds a batching nudge (independent reads in one turn).
// Phase 2 appends the verify-before-commit rule to this prompt.
func agentSystemStrong() string {
	now := time.Now().Format("Monday, 2 January 2006, 15:04 MST")
	return "You are a coding agent. Today is " + now + ". " +
		"Use tools to inspect the codebase (tree, grep, glob, read_file, git_status) and make changes " +
		"(edit_file, write_file, run_command) directly — do not describe changes in prose, apply them. " +
		"Discover codebase facts yourself; never ask the user where something is or how it works. " +
		"Batch independent read operations in a single turn when possible. " +
		"If you genuinely need a choice only the user can make, call ask_user. " +
		"Before committing, run the project's check or test command and read any failures — fix them before calling git_commit. " +
		"After the work is done, synthesize a clear final answer for the user. Keep answers concise."
}

// toolCallDiscipline is the anti-narration guardrail appended to every
// tool-calling system prompt (agent / web-search / clarify / ask_user). Some
// local models report a "tools" capability yet fail to emit structured
// tool_calls, and instead narrate the call — and a fabricated result or error
// ("Error: Function get_time not found.") — as plain text, which the loop
// then streams to the user as if it were a real answer. This rule states the
// only valid way to use a tool is a structured tool call, forbids writing tool
// calls / results / errors as prose, and steers the model to answer directly
// when no tool is needed. It does not override a model's native tool-call
// format (Ollama's chat template governs that), but it sharply reduces the
// narration failure mode. Keep the anchor phrase "never invent a tool result"
// stable — agent_test.go asserts on it.
func toolCallDiscipline() string {
	return "Tools run only through structured tool calls, never as text. " +
		"Do not narrate a tool call, do not write a tool's name or arguments in prose, and " +
		"never invent a tool result or tool error (for example \"Error: Function X not found\"). " +
		"A tool executes only when you emit a structured tool call. If a tool is genuinely " +
		"needed, emit that tool call; otherwise answer directly and do not mention tools at all."
}

package main

import "strings"

// --- UI tools (local: executed by the page itself, not the sidecar) --------
//
// These let the agent see and act on the chat app's OWN user interface — the
// screen the user is looking at while they talk to it. Without them the model
// has no way to answer "what's the number next to the drawer icon?" except by
// guessing or disclaiming ("I'm unable to interact with the user interface"),
// because that number exists only in the live DOM.
//
// They are local tools (relayed via the toolExec SSE cue) like the repo and
// ssh_* families, but their executor is different: the PAGE runs them, not the
// desktop sidecar. www/ui.js implements them so the same code serves both the
// desktop shell and the plain browser UI; desktop.js's toolExec shim skips
// ui_* and lets www/ own them.
//
// Opt-in, like ssh_* and fetch_page: they are not in defaultAgentTools. The
// reason is not safety but job lifecycle — an allowlist containing a ui_* tool
// makes the run browser-bound (agentRunNeedsBrowser), and a server-model agent
// run that today survives the app closing would start being grace-cancelled.

// uiTargetApp is the only UI target that exists today: the chat app's own
// interface. It rides on the toolExec payload (toolExecPayload.Target) rather
// than in the tool schema, so the model never spends tokens choosing a
// constant. A second target (e.g. a dev-server preview pane) becomes a new
// value here, a renderer that routes on it, and — only then — a target param
// on the schemas below.
const uiTargetApp = "app"

// uiToolDef is one entry in the single-source UI tool table. Mirrors toolDef
// (agent_tools.go) so the name list, the UI menu metadata, the registry
// schemas, and the Plan-mode write gate are all derived from one place and
// cannot drift.
type uiToolDef struct {
	Name     string
	Schema   func() oaiTool
	Label    string
	Desc     string
	IsAction bool // true → changes what the user sees: approval-gated in the renderer, and gated out in Plan mode before approval
}

// uiToolDefs is the single source of truth for the ui_* family. Read tools
// first, then the actions, matching localToolDefs' ordering convention.
var uiToolDefs = []uiToolDef{
	{Name: "ui_snapshot", Schema: uiSnapshotTool, Label: "UI snapshot", Desc: "See the app's current screen: visible controls, labels, and state."},
	{Name: "ui_read", Schema: uiReadTool, Label: "UI read", Desc: "Read one UI element's full text and state."},
	{Name: "ui_click", Schema: uiClickTool, Label: "UI click", Desc: "Click a control in the app's UI. Approval-gated.", IsAction: true},
	{Name: "ui_set_value", Schema: uiSetValueTool, Label: "UI set value", Desc: "Type a value into a field in the app's UI. Approval-gated.", IsAction: true},
}

func uiSnapshotTool() oaiTool {
	return oaiTool{Type: "function", Function: oaiToolFunction{
		Name: "ui_snapshot",
		Description: "Look at the app's screen as the user currently sees it. Returns the visible regions and controls with a ref, a label, and their state (active, disabled, checked, current value, badge count). " +
			"Call this whenever the user asks about something on screen — a badge, a counter, a button, a panel, an icon, \"what does this show\", \"why is that highlighted\" — instead of guessing or saying you cannot see the interface. " +
			"The refs it returns are what ui_read, ui_click, and ui_set_value take.",
		Parameters: map[string]any{"type": "object", "properties": map[string]any{
			"area": map[string]any{
				"type":        "string",
				"enum":        []string{"all", "sidebar", "header", "chat", "composer", "drawer", "dialog"},
				"description": "Narrow the snapshot to one region. Defaults to \"all\" (the whole screen).",
			},
		}},
	}}
}

func uiReadTool() oaiTool {
	return oaiTool{Type: "function", Function: oaiToolFunction{
		Name:        "ui_read",
		Description: "Read one element of the app's UI in full: its text, label, tooltip, and state. Use this when a ui_snapshot line was truncated, or when you need the exact wording of a control, panel, or message. Read-only.",
		Parameters: map[string]any{"type": "object", "properties": map[string]any{
			"ref": map[string]any{"type": "string", "description": "A ref from the most recent ui_snapshot, e.g. #modelBtn or s2:e14."},
		}, "required": []string{"ref"}},
	}}
}

func uiClickTool() oaiTool {
	return oaiTool{Type: "function", Function: oaiToolFunction{
		Name: "ui_click",
		Description: "Click a control in the app's UI — a button, tab, menu item, or checkbox. Call ui_snapshot first to get the ref; refs go stale as soon as the UI changes, so re-snapshot after anything that redraws. " +
			"This changes what the user sees, so only click what the request actually needs. Destructive controls always ask the user to approve first.",
		Parameters: map[string]any{"type": "object", "properties": map[string]any{
			"ref": map[string]any{"type": "string", "description": "A ref from the most recent ui_snapshot, e.g. #modelBtn or s2:e14."},
		}, "required": []string{"ref"}},
	}}
}

func uiSetValueTool() oaiTool {
	return oaiTool{Type: "function", Function: oaiToolFunction{
		Name:        "ui_set_value",
		Description: "Type a value into a text input, textarea, or dropdown in the app's UI. Replaces the field's current value and fires the app's own input/change handlers. Call ui_snapshot first to get the ref.",
		Parameters: map[string]any{"type": "object", "properties": map[string]any{
			"ref":   map[string]any{"type": "string", "description": "A ref from the most recent ui_snapshot, e.g. #input or s2:e14."},
			"value": map[string]any{"type": "string", "description": "The value to put in the field."},
		}, "required": []string{"ref", "value"}},
	}}
}

// uiTools is the ordered list of ui_* tool names, derived from uiToolDefs.
// Mirrors sshTools/localRepoTools. Not in defaultAgentTools (opt-in).
func uiTools() []string {
	out := make([]string, len(uiToolDefs))
	for i, d := range uiToolDefs {
		out[i] = d.Name
	}
	return out
}

// uiActionTools is the subset that mutates the interface (ui_click,
// ui_set_value). Appended to planWriteTools so a plan-mode run that hasn't
// been approved yet can look at the UI but not drive it.
func uiActionTools() []string {
	var out []string
	for _, d := range uiToolDefs {
		if d.IsAction {
			out = append(out, d.Name)
		}
	}
	return out
}

// uiToolMetas is the UI-facing metadata for the ui_* family, in the same
// order, so availableTools stays in lockstep with the registry.
func uiToolMetas() []toolMeta {
	out := make([]toolMeta, len(uiToolDefs))
	for i, d := range uiToolDefs {
		out[i] = toolMeta{Name: d.Name, Label: d.Label, Description: d.Desc}
	}
	return out
}

// isUITool reports whether name is one of the ui_* tools.
func isUITool(name string) bool { return strings.HasPrefix(name, "ui_") }

// containsAnyUITool reports whether the allowlist contains any ui_* tool.
// Drives both the toolExec relay (a UI-enabled run needs one even with no repo
// bound) and agentRunNeedsBrowser (such a run is connection-bound).
func containsAnyUITool(allow []string) bool {
	for _, t := range allow {
		if isUITool(t) {
			return true
		}
	}
	return false
}

// uiTargetFor returns the toolExec target for a tool: the app's own UI for a
// ui_* tool, empty for everything else (repo/ssh tools route on repo/host
// instead). The single place a future second target would be chosen.
func uiTargetFor(tool string) string {
	if isUITool(tool) {
		return uiTargetApp
	}
	return ""
}

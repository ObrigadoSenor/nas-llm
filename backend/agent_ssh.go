package main

import (
	"encoding/json"
	"strings"
)

// --- SSH tools (local: executed by the desktop sidecar over ssh, using the ---
// user's ~/.ssh/config + keys). Opt-in: only registered when the user has ≥1
// configured SSH host (see toolRegistry). The host param is an enum of the
// user's aliases so the model can only target allowlisted hosts; no credentials
// are stored. ssh_run always prompts; the read tools are approval-free.

func sshRunTool(hosts []string) oaiTool {
	return oaiTool{Type: "function", Function: oaiToolFunction{
		Name:        "ssh_run",
		Description: "Run a shell command on a remote host over SSH. The host must be one of your configured SSH aliases (resolved via ~/.ssh/config on the desktop). Always approved by the user before running — the user sees the host and the exact command. Use this to inspect or act on data on another machine.",
		Parameters: map[string]any{"type": "object", "properties": map[string]any{
			"host":    map[string]any{"type": "string", "enum": hosts, "description": "The SSH alias to target (one of your configured hosts)."},
			"command": map[string]any{"type": "string", "description": "The shell command to run on the remote host."},
		}, "required": []string{"host", "command"}},
	}}
}

func sshReadTool(hosts []string) oaiTool {
	return oaiTool{Type: "function", Function: oaiToolFunction{
		Name:        "ssh_read",
		Description: "Read the contents of a remote file over SSH (cat). Read-only — no approval needed. Use this to examine a config file, log, or source file on another machine.",
		Parameters: map[string]any{"type": "object", "properties": map[string]any{
			"host": map[string]any{"type": "string", "enum": hosts, "description": "The SSH alias to target."},
			"path": map[string]any{"type": "string", "description": "Absolute path to the remote file to read."},
		}, "required": []string{"host", "path"}},
	}}
}

func sshListTool(hosts []string) oaiTool {
	return oaiTool{Type: "function", Function: oaiToolFunction{
		Name:        "ssh_list",
		Description: "List the contents of a remote directory over SSH (ls -la). Read-only — no approval needed. Use this to explore the layout of a remote filesystem.",
		Parameters: map[string]any{"type": "object", "properties": map[string]any{
			"host": map[string]any{"type": "string", "enum": hosts, "description": "The SSH alias to target."},
			"path": map[string]any{"type": "string", "description": "Absolute path to the remote directory to list (default the remote home directory)."},
		}, "required": []string{"host"}},
	}}
}

func sshGrepTool(hosts []string) oaiTool {
	return oaiTool{Type: "function", Function: oaiToolFunction{
		Name:        "ssh_grep",
		Description: "Search for a text pattern in remote files over SSH (grep -rn). Returns matching lines with file:line prefixes. Read-only — no approval needed. Use this to find where a symbol, function, or string is used on another machine.",
		Parameters: map[string]any{"type": "object", "properties": map[string]any{
			"host":    map[string]any{"type": "string", "enum": hosts, "description": "The SSH alias to target."},
			"pattern": map[string]any{"type": "string", "description": "The text pattern to search for."},
			"path":    map[string]any{"type": "string", "description": "Absolute path to the remote directory to search in (default the remote home directory)."},
			"include": map[string]any{"type": "string", "description": "Optional glob to limit searched files, e.g. *.go."},
		}, "required": []string{"host", "pattern"}},
	}}
}

// sshTools is the ordered list of SSH agent tool names, mirroring localRepoTools
// for the repo file tools. SSH tools are opt-in (not in defaultAgentTools) and
// only registered/offered when the user has ≥1 configured SSH host.
func sshTools() []string {
	return []string{"ssh_run", "ssh_read", "ssh_list", "ssh_grep"}
}

// sshToolMetas is the UI-facing metadata for sshTools, in the same order, so
// availableTools stays in lockstep with the allowlist/registry.
func sshToolMetas() []toolMeta {
	return []toolMeta{
		{Name: "ssh_run", Label: "SSH run", Description: "Run a shell command on a remote host over SSH. Always prompts. (Desktop only.)"},
		{Name: "ssh_read", Label: "SSH read", Description: "Read a remote file over SSH (cat). Read-only. (Desktop only.)"},
		{Name: "ssh_list", Label: "SSH list", Description: "List a remote directory over SSH (ls). Read-only. (Desktop only.)"},
		{Name: "ssh_grep", Label: "SSH grep", Description: "Search remote file contents over SSH (grep). Read-only. (Desktop only.)"},
	}
}

// isSSHTool reports whether name is one of the ssh_* tools.
func isSSHTool(name string) bool { return strings.HasPrefix(name, "ssh_") }

// containsAnySSHTool reports whether the allowlist contains any ssh_* tool.
func containsAnySSHTool(allow []string) bool {
	for _, t := range allow {
		if isSSHTool(t) {
			return true
		}
	}
	return false
}

// filterSSHTools returns allow with any ssh_* tools removed. Used when a user
// has no configured hosts so a run never offers tools whose host enum would be
// empty (guards the deleted-all-hosts edge case — toolRegistry also won't
// register them). Filters in place over the backing array.
func filterSSHTools(allow []string) []string {
	out := allow[:0]
	for _, t := range allow {
		if !isSSHTool(t) {
			out = append(out, t)
		}
	}
	return out
}

// sshHostAliases extracts the alias list from a user's SSHHost records, in the
// order listSSHHosts returns them (most-recent first). Used to build the tool
// host enum and to gate the availableTools menu.
func sshHostAliases(hosts []SSHHost) []string {
	out := make([]string, 0, len(hosts))
	for _, h := range hosts {
		out = append(out, h.Alias)
	}
	return out
}

// sshHostAllowed reports whether alias is in the user's allowlist. The relay
// validates the model-supplied host against this before emitting a cue, so a
// hallucinated host never reaches the sidecar.
func sshHostAllowed(hosts []SSHHost, alias string) bool {
	for _, h := range hosts {
		if h.Alias == alias {
			return true
		}
	}
	return false
}

// sshHostList joins a user's aliases into a comma-separated string for an error
// observation when the model names an unknown host.
func sshHostList(hosts []SSHHost) string {
	out := make([]string, 0, len(hosts))
	for _, h := range hosts {
		out = append(out, h.Alias)
	}
	return strings.Join(out, ", ")
}

// parseSSHHost extracts the host alias from an ssh_* tool's args JSON. Returns
// "" if the args don't carry a host; the relay then surfaces an error
// observation instead of emitting a cue with no target.
func parseSSHHost(args string) string {
	var p struct {
		Host string `json:"host"`
	}
	if json.Unmarshal([]byte(args), &p) == nil {
		return strings.TrimSpace(p.Host)
	}
	return ""
}

// isSSHAlias reports whether s is a safe bare SSH alias (a ~/.ssh/config Host
// nickname): no whitespace, no shell metacharacters, conservative charset. The
// alias is passed to ssh as a single argv element, so this guards against a UI
// bug (or a crafted request) injecting ssh options like "-oProxyCommand=…".
func isSSHAlias(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		case r == '.', r == '-', r == '_':
		default:
			return false
		}
	}
	return true
}

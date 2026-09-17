package main

import (
	"encoding/json"
	"regexp"
	"strings"
)

// parseProseToolCallBlob interprets a JSON object (blob) as a tool call a small
// model wrote in prose, returning the tool name and normalized arguments when
// the name matches an offered tool. It recognizes the key spellings that show
// up across local-model chat templates — not just the OpenAI
// {"name":..,"arguments":..} shape but also {"tool":..,"input":..} and
// {"function":..,"parameters":..} — plus the nested OpenAI tool_calls shape
// {"type":"function","function":{"name":..,"arguments":..}}. ok is false for a
// JSON object that isn't a tool call (e.g. {"key":"value"}) so a caller can
// leave non-tool JSON alone. extractProseToolCall and stripProseToolCallText
// both go through here so they agree on what counts as a recovered call.
func parseProseToolCallBlob(blob string, offered map[string]bool) (name, args string, ok bool) {
	var fields map[string]json.RawMessage
	if json.Unmarshal([]byte(blob), &fields) != nil {
		return "", "", false
	}
	// "function" is either a string alias for the tool name ({"function":..,
	// "parameters":..}) or the nested OpenAI object {"name":..,"arguments":..}.
	if fn, has := fields["function"]; has {
		if s := rawString(fn); s != "" {
			name = s
		} else {
			var inner map[string]json.RawMessage
			if json.Unmarshal(fn, &inner) == nil {
				name = rawString(firstRaw(inner, "name", "tool"))
				args = normalizeProseArgs(firstRaw(inner, "arguments", "input", "parameters", "args"))
			}
		}
	}
	if name == "" {
		name = rawString(firstRaw(fields, "name", "tool"))
	}
	if name == "" || !offered[name] {
		return "", "", false
	}
	if args == "" {
		args = normalizeProseArgs(firstRaw(fields, "arguments", "input", "parameters", "args"))
	}
	return name, args, true
}

// rawString unmarshals a JSON RawMessage that is expected to be a string and
// returns it; any other JSON type (object, number, bool, null) yields "".
func rawString(r json.RawMessage) string {
	var s string
	if json.Unmarshal(r, &s) == nil {
		return s
	}
	return ""
}

// firstRaw returns the value of the first of keys present in fields, or nil.
func firstRaw(fields map[string]json.RawMessage, keys ...string) json.RawMessage {
	for _, k := range keys {
		if v, ok := fields[k]; ok {
			return v
		}
	}
	return nil
}

// normalizeProseArgs turns the raw arguments of a recovered prose tool call into
// the bare-object string the tool executor expects: an object/array is kept
// as-is, a JSON string (the OpenAI tool_calls shape, where arguments is itself a
// JSON-encoded string) is unwrapped, and missing/null becomes "{}".
func normalizeProseArgs(raw json.RawMessage) string {
	s := strings.TrimSpace(string(raw))
	if s == "" || s == "null" {
		return "{}"
	}
	var asStr string
	if json.Unmarshal(raw, &asStr) == nil {
		t := strings.TrimSpace(asStr)
		if strings.HasPrefix(t, "{") || strings.HasPrefix(t, "[") {
			return t
		}
		return asStr
	}
	return s
}

// extractProseToolCall scans text for the first JSON object shaped like a tool
// call ({"name": "...", "arguments": {...}} and the alias shapes documented on
// parseProseToolCallBlob) whose name is an offered tool, and returns a
// synthesized oaiToolCall to execute. It recovers tool calls a small model
// wrote as prose (often in a fenced code block) because it could not emit
// structured tool_calls deltas — without this the agent loop dead-ends on the
// narration. offered is the set of tool names actually sent to the model this
// run (so a call to a filtered-out local tool is not recovered). Only the first
// parseable call is returned; the model frequently writes the same call twice.
func extractProseToolCall(text string, offered map[string]bool) (oaiToolCall, bool) {
	for i := 0; i < len(text); i++ {
		if text[i] != '{' {
			continue
		}
		end := findJSONEnd(text, i)
		if end < 0 {
			// An unbalanced '{' (e.g. a stray brace in the model's preamble,
			// "I'll use the { approach") must not stop the scan — a real tool
			// call blob may follow it. Advance past this '{' and keep looking.
			continue
		}
		name, args, ok := parseProseToolCallBlob(text[i:end+1], offered)
		if ok {
			var tc oaiToolCall
			tc.ID = "prose_" + name
			tc.Type = "function"
			tc.Function.Name = name
			tc.Function.Arguments = args
			return tc, true
		}
		// Do NOT jump to end. A '{' in the preamble ("the {project} name") can
		// balance against a '}' INSIDE the real tool-call blob, so text[i:end+1]
		// is an invalid chunk spanning past the real blob. Skipping to end would
		// leapfrog the blob entirely — the call is never recovered and its JSON
		// is streamed to the user as prose. Advance one byte and rescan so the
		// real blob's '{' is found on a later iteration.
	}
	return oaiToolCall{}, false
}

// stripProseToolCallText removes JSON tool-call blobs (the raw
// {"name":"...","arguments":{...}} a small model wrote as prose) and any
// fenced code-block wrapper around them from text, so the thinking drawer shows
// the model's reasoning rather than the recovered tool-call syntax. offered
// matches extractProseToolCall so only a real recovered call is stripped — a
// JSON object that isn't a tool call is left alone.
func stripProseToolCallText(text string, offered map[string]bool) string {
	for i := 0; i < len(text); i++ {
		if text[i] != '{' {
			continue
		}
		end := findJSONEnd(text, i)
		if end < 0 {
			// An unbalanced '{' in the preamble must not stop the scan; a real
			// tool-call blob may follow it. (Mirrors extractProseToolCall.)
			continue
		}
		blob := text[i : end+1]
		if _, _, ok := parseProseToolCallBlob(blob, offered); !ok {
			// Do NOT jump to end — a spurious '{' can balance against a '}'
			// inside the real blob (see extractProseToolCall). Advance one byte
			// so the real blob is still found and stripped on a later iteration.
			continue
		}
		// Found a tool-call blob — strip it, absorbing a fenced code-block
		// wrapper (```json\n{...}\n``` or ```\n{...}\n```) if present.
		lo, hi := i, end+1
		if rest := strings.TrimLeft(text[hi:], " \t"); strings.HasPrefix(rest, "```") {
			hi += len(text) - hi - len(rest) + 3
			if hi < len(text) && text[hi] == '\n' {
				hi++
			}
		}
		prefix := text[:lo]
		if trimmed := strings.TrimRight(prefix, " \t"); strings.HasSuffix(trimmed, "```") {
			lineStart := strings.LastIndex(prefix, "\n")
			if lineStart < 0 {
				lineStart = 0
			}
			if fenceLine := strings.TrimSpace(prefix[lineStart:]); fenceLine == "```" || strings.HasPrefix(fenceLine, "```") {
				lo = lineStart
			}
		}
		text = text[:lo] + text[hi:]
		i = lo
		if i > 0 {
			i--
		}
	}
	text = emptyFenceRe.ReplaceAllString(text, "")
	text = blankRunRe.ReplaceAllString(text, "\n\n")
	return strings.TrimSpace(text)
}

var (
	emptyFenceRe = regexp.MustCompile("```[a-zA-Z]*\\n\\s*```")
	blankRunRe   = regexp.MustCompile(`\n{3,}`)
)

// findJSONEnd returns the index of the closing '}' that balances the '{' at
// start, accounting for nested objects and string literals. Returns -1 if the
// object is unbalanced. Used by extractProseToolCall to carve JSON blobs out of
// prose without a full JSON tokenizer.
func findJSONEnd(s string, start int) int {
	depth := 0
	inStr := false
	esc := false
	for i := start; i < len(s); i++ {
		c := s[i]
		if inStr {
			if esc {
				esc = false
			} else if c == '\\' {
				esc = true
			} else if c == '"' {
				inStr = false
			}
			continue
		}
		if c == '"' {
			inStr = true
			continue
		}
		if c == '{' {
			depth++
		}
		if c == '}' {
			depth--
			if depth == 0 {
				return i
			}
		}
	}
	return -1
}

// looksLikeNarration reports whether text reads like the model describing an
// action it intends to take ("I'll edit...", "Let me change...") rather than a
// genuine final answer. Used by the agent loop's narration guard to re-prompt a
// small model that narrates a tool call instead of emitting one. Conservative:
// only first-person intention phrasing triggers it, so a real answer ("The file
// is X", "Done") is left alone and returned as the final answer.
func looksLikeNarration(text string) bool {
	t := strings.ToLower(strings.TrimSpace(text))
	if t == "" {
		return false
	}
	for _, p := range []string{
		"i'll", "i will", "i would", "i'd like", "i'd go", "let me", "i'm going to",
		"i am going to", "i plan to", "here's what i", "i could edit", "i can edit",
		"i will edit", "i'll edit", "i'll change", "i will change", "i'll add",
		"i will add", "i'll create", "i will create", "i'll run", "i will run",
		"i'll update", "i will update", "i'll modify", "i will modify", "i'll replace",
		"i will replace", "i'll remove", "i will remove", "i'll fix", "i will fix",
	} {
		if strings.Contains(t, p) {
			return true
		}
	}
	return false
}

// looksLikeAwaitingToolResult reports whether text reads like the agent
// asking the user to hand it a tool output or run a command for it ("Please
// provide the output from the tool response so I can proceed…") — the prose
// dead-end that neither extractProseToolCall (no JSON blob) nor
// looksLikeNarration (first-person intention only) catches, so it would
// otherwise be streamed to the user as the final answer. Conservative: every
// phrase requires a request verb or an explicit "tool response so I can"
// clause, so a genuine answer that merely mentions a result ("The get_time
// tool returned 3pm.") does not match.
func looksLikeAwaitingToolResult(text string) bool {
	t := strings.ToLower(strings.TrimSpace(text))
	if t == "" {
		return false
	}
	for _, p := range []string{
		"provide the output", "provide the result", "provide the tool response",
		"please provide", "please paste", "please run",
		"paste the output", "paste the result", "paste the tool",
		"the output from the tool", "tool response so i can",
		"waiting for the tool", "awaiting the tool",
		"i need the output", "i need the result", "i need you to",
		"could you provide", "can you provide",
		"could you run", "can you run",
		"could you paste", "can you paste",
		"share the output", "send the output",
	} {
		if strings.Contains(t, p) {
			return true
		}
	}
	return false
}

// awaitingToolNudge is the corrective system message fed back when the guard
// re-prompts a stalling model. The awaiting variant states the fact the
// dead-end prose gets wrong — no tool has run yet, so there is no output to
// provide, and a tool runs only via a structured tool call whose result is
// returned automatically — and directs the model to emit one now. The
// narration variant (awaiting == false) tells a model that described an action
// to emit the matching tool call instead. Both list the tools actually offered
// this run (built by agentToolHint from the allowlist), so a model that narrates
// an intent — e.g. "I will create a new pull request" — is steered to the
// matching tool (create_pr) rather than a fixed example list that omits it.
// ask_user is called out in the suffix, so it is not duplicated in the list.
func awaitingToolNudge(awaiting bool, offered map[string]bool) string {
	tools := agentToolHint(offered)
	if awaiting {
		return "No tool has run yet, so there is no tool output to provide. The user will not paste a tool result or run a command for you — a tool executes only when YOU emit a structured tool call, and its output is returned to you automatically as the observation. Emit a structured tool call now to actually make progress: " + tools + ". If you genuinely cannot proceed without information only the user can give, call ask_user. Do not ask the user for tool output."
	}
	return "You described what you would do but did not call a tool. Do not explain, describe, or narrate a plan — emit a structured tool call NOW to actually do it: " + tools + ". If you genuinely cannot proceed without information from the user, call ask_user. Do not write another plan."
}

// agentToolHint renders the tool-list portion of the narration/awaiting nudge
// from the tools actually offered this run (the `added` map), grouped by intent
// so a narrating small model can map "I will <do X>" to the matching tool. Only
// categories with at least one offered tool are included, so the nudge never
// names a tool the model does not have (e.g. create_pr in a non-repo chat, where
// local tools are filtered out before the loop). ask_user is handled in the
// nudge's suffix, not here. Order is stable for readability.
func agentToolHint(offered map[string]bool) string {
	cats := []struct {
		hint  string
		names []string
	}{
		{"to inspect the codebase", []string{"read_file", "grep", "glob", "list_files", "tree", "git_status", "git_log"}},
		{"to edit a file", []string{"edit_file", "write_file"}},
		{"to apply a multi-file diff", []string{"apply_patch"}},
		{"to delete or move a path", []string{"delete_path", "move_path"}},
		{"to run a command", []string{"run_command"}},
		{"to commit", []string{"git_commit"}},
		{"to push", []string{"git_push"}},
		{"to open a pull request", []string{"create_pr"}},
		{"to merge a pull request", []string{"merge_pr"}},
		{"to inspect pull requests", []string{"list_prs", "pr_view", "pr_diff", "pr_checks"}},
		{"to act on a pull request", []string{"pr_comment", "pr_close", "pr_ready", "pr_edit"}},
		{"to create a repository", []string{"create_repo"}},
		{"to link a remote", []string{"link_remote"}},
		{"to search the web", []string{"web_search"}},
		{"to fetch a web page", []string{"fetch_page"}},
		{"to get the time", []string{"get_time"}},
		{"to evaluate arithmetic", []string{"calculator"}},
		{"to recall a memory note", []string{"memory_read"}},
		{"to save a memory note", []string{"memory_write"}},
		{"to update the task list", []string{"todo_write"}},
		{"to read the task list", []string{"todo_read"}},
		{"to run a command over SSH", []string{"ssh_run", "ssh_read", "ssh_list", "ssh_grep"}},
	}
	var parts []string
	for _, c := range cats {
		var have []string
		for _, n := range c.names {
			if offered[n] {
				have = append(have, n)
			}
		}
		if len(have) == 0 {
			continue
		}
		parts = append(parts, strings.Join(have, "/")+" "+c.hint)
	}
	if len(parts) == 0 {
		return "call one of your available tools"
	}
	return strings.Join(parts, ", ")
}

// synthesizeProceedCard builds a clickable "proceed" clarify card from an
// agent turn that asked the user to hand it a tool output / run a command
// (the prose dead-end), for the interactive fallback. It reuses the ask_user
// clarify-card UI and answer path: the user's click becomes a new user turn
// that re-runs the agent, nudging it back to running its tools itself. The
// agent's prose is the card's question text; the single option is a
// "Continue" nudge whose value is sent as the user's reply.
func synthesizeProceedCard(text string) clarifyMeta {
	return clarifyMeta{Questions: []clarifyQuestion{{
		Text:    capObservation(strings.TrimSpace(text), agentObsMaxChars),
		Type:    "single",
		Options: []clarifyOption{{Label: "Continue", Value: "Please proceed — run the available tools yourself and use their output directly."}},
	}}}
}

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
)

// --- Clarifying-question tool (the "agent loop") ---------------------------
//
// When the Clarify extra is on, runGeneration routes through runClarifyLoop:
// it gives the model an ask_user tool and streams one tool-calling pass. If the
// model calls ask_user, this is a *terminal* outcome for the generation: the
// structured question + options are stashed on the job (emitQuestions) and an
// SSE "questions" event + "clarifying" phase are broadcast, then the loop
// returns nil. The job worker sees the stashed clarify meta and persists the
// assistant turn as a clarifying question (Content = the question text, for the
// model's own context next round; Clarify = the structured card for the UI).
//
// The user's clicked option is just the next user message — it re-enters the
// existing /generate flow, so the model re-reads the full history and either
// asks again (until MAX_CLARIFY_ROUNDS) or answers. No parked-job state, no
// resume endpoint: a half-answered question survives a backend restart because
// it lives in the conversation, not in memory.

// clarifyOption is one clickable answer. Value is what gets sent as the user's
// reply when picked; it defaults to Label when empty (set by the frontend).
type clarifyOption struct {
	Label string `json:"label"`
	Value string `json:"value,omitempty"`
}

// clarifyQuestion is one question to show as a card. Type is "single" (pick one
// option, the v1 UI), "multi" (pick several — forward-compat), or "free" (no
// options; the user types an answer in the composer).
type clarifyQuestion struct {
	Text    string          `json:"text"`
	Type    string          `json:"type,omitempty"`
	Options []clarifyOption `json:"options,omitempty"`
}

// clarifyMeta is the per-message clarifying record, persisted on Message.Clarify
// (rides in the messages JSON blob, omitempty so old rows stay byte-identical).
type clarifyMeta struct {
	Questions []clarifyQuestion `json:"questions,omitempty"`
}

var askUserTool = oaiTool{
	Type: "function",
	Function: oaiToolFunction{
		Name:        "ask_user",
		Description: "Ask the user a clarifying question when their request is ambiguous or missing a key detail. Provide concrete, distinct options the user can pick from. Only call this when you genuinely need more information before you can help; otherwise answer directly.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"questions": map[string]any{
					"type":        "array",
					"description": "One or more clarifying questions. Use a single question in most cases.",
					"items": map[string]any{
						"type": "object",
						"properties": map[string]any{
							"text": map[string]any{
								"type":        "string",
								"description": "The question to ask the user.",
							},
							"type": map[string]any{
								"type":        "string",
								"enum":        []string{"single", "multi", "free"},
								"description": "single = pick one option; multi = pick several; free = no options, the user types a free-text answer.",
							},
							"options": map[string]any{
								"type":        "array",
								"description": "Options for single/multi. Omit (or empty) when type is free.",
								"items": map[string]any{
									"type": "object",
									"properties": map[string]any{
										"label": map[string]any{
											"type":        "string",
											"description": "Short, user-facing option label.",
										},
										"value": map[string]any{
											"type":        "string",
											"description": "The value to use as the user's answer if picked. Defaults to label if omitted.",
										},
									},
									"required": []string{"label"},
								},
							},
						},
						"required": []string{"text", "type"},
					},
				},
			},
			"required": []string{"questions"},
		},
	},
}

func clarifyNudge() oaiMessage {
	return oaiMessage{Role: "system", Content: jsonString(
		"You have an ask_user tool to clarify ambiguous requests. " +
			"If the user's task is unclear or missing a key detail, call ask_user with a clear question and concrete, distinct options. " +
			"Ask only what you truly need, and at most a couple of questions across the conversation, then answer directly. " +
			"Do not call ask_user if the request is already clear enough to answer.")}
}

// runClarifyLoop streams one tool-calling pass with the ask_user tool. If the
// model calls ask_user, it stashes the parsed questions on the job (via
// emitQuestions) and returns nil — the worker then persists a clarifying turn.
// If the model answers directly (no tool call), the streamed content is the
// answer and the worker persists a normal assistant message.
func (s *server) runClarifyLoop(ctx context.Context, model string, msgs []oaiMessage, emit func(string), emitPhase func(string), emitQuestions func(clarifyMeta)) error {
	emitPhase("clarifying")
	ollamaChatURL := strings.TrimRight(s.cfg.ollamaURL, "/") + "/v1/chat/completions"
	req := chatRequest{
		Model:    model,
		Messages: append([]oaiMessage{clarifyNudge()}, msgs...),
		Tools:    []oaiTool{askUserTool},
	}

	msg, _, err := s.streamOllamaChatWithTools(ctx, ollamaChatURL, &req, emit)
	if err != nil {
		return fmt.Errorf("clarify failed: %w", err)
	}

	var askCall *oaiToolCall
	for i := range msg.ToolCalls {
		if msg.ToolCalls[i].Function.Name == "ask_user" {
			askCall = &msg.ToolCalls[i]
			break
		}
	}
	if askCall == nil {
		// Answered directly without asking. Content was already streamed.
		emitPhase("answering")
		if len(msg.Content) == 0 {
			emit("(no response)")
		}
		return nil
	}

	meta := parseClarifyQuestions(askCall.Function.Arguments)
	if meta == nil || len(meta.Questions) == 0 {
		// Malformed call — fall back to whatever was streamed as the answer.
		emitPhase("answering")
		return nil
	}

	// Terminal clarifying outcome: stash the card on the job and tell the UI.
	emitQuestions(*meta)
	emitPhase("clarifying")
	return nil
}

// parseClarifyQuestions decodes the ask_user tool-call arguments into a
// clarifyMeta. Returns nil on a malformed/empty call so the caller can fall
// back to treating the streamed text as a plain answer.
func parseClarifyQuestions(argsJSON string) *clarifyMeta {
	var args struct {
		Questions []struct {
			Text    string `json:"text"`
			Type    string `json:"type"`
			Options []struct {
				Label string `json:"label"`
				Value string `json:"value"`
			} `json:"options"`
		} `json:"questions"`
	}
	if err := json.Unmarshal([]byte(argsJSON), &args); err != nil || len(args.Questions) == 0 {
		return nil
	}
	meta := &clarifyMeta{}
	for _, q := range args.Questions {
		cq := clarifyQuestion{Text: strings.TrimSpace(q.Text), Type: q.Type}
		if cq.Type == "" {
			cq.Type = "single"
		}
		for _, o := range q.Options {
			label := strings.TrimSpace(o.Label)
			if label == "" {
				continue
			}
			cq.Options = append(cq.Options, clarifyOption{Label: label, Value: strings.TrimSpace(o.Value)})
		}
		meta.Questions = append(meta.Questions, cq)
	}
	if len(meta.Questions) == 0 {
		return nil
	}
	return meta
}

// clarifyAsContent renders the question text(s) as plain assistant content, so
// the model has context for the user's follow-up answer on the next round (the
// stored assistant turn carries the question text as Content; the structured
// card for the UI lives in Clarify). Preamble the model produced before calling
// ask_user is dropped in favor of the explicit question text.
func clarifyAsContent(meta *clarifyMeta) string {
	if meta == nil {
		return ""
	}
	var b strings.Builder
	for i, q := range meta.Questions {
		if i > 0 {
			b.WriteString("\n")
		}
		b.WriteString(q.Text)
	}
	return b.String()
}

// countRecentClarify counts clarifying assistant turns in the current clarify
// session: it walks back from the end, counting assistant messages whose Clarify
// is set, and stops at the first assistant message that was a normal answer (or
// the start of the conversation). User messages in between are skipped. Used to
// cap the number of back-to-back questions at MAX_CLARIFY_ROUNDS.
func countRecentClarify(msgs []Message) int {
	n := 0
	for i := len(msgs) - 1; i >= 0; i-- {
		m := msgs[i]
		if m.Role != "assistant" {
			continue
		}
		if m.Clarify != nil {
			n++
			continue
		}
		break
	}
	return n
}

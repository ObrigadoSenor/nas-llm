package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

type mailer interface {
	sendMagicLink(to, link string) error
}

type brevoMailer struct {
	apiKey string
	from   string
}

func (m *brevoMailer) sendMagicLink(to, link string) error {
	if m.apiKey == "" {
		return fmt.Errorf("BREVO_API_KEY not set; cannot send magic link")
	}
	fromName, fromEmail := splitAddr(m.from)
	body := map[string]any{
		"sender":      map[string]string{"email": fromEmail, "name": fromName},
		"to":          []map[string]string{{"email": to}},
		"subject":     "Your nas-llm sign-in link",
		"htmlContent": fmt.Sprintf(`<p>Click the link below to sign in to nas-llm. It expires in 15 minutes and works once.</p><p><a href="%s">Sign in</a></p><p style="color:#888;font-size:12px">If you didn't request this, ignore this email.</p>`, link),
		"textContent": fmt.Sprintf("Sign in to nas-llm by opening this link (expires in 15 minutes, one use):\n%s\n\nIf you didn't request this, ignore this email.", link),
	}
	buf, _ := json.Marshal(body)
	req, err := http.NewRequest(http.MethodPost, "https://api.brevo.com/v3/smtp/email", bytes.NewReader(buf))
	if err != nil {
		return err
	}
	req.Header.Set("api-key", m.apiKey)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("accept", "application/json")
	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("brevo returned HTTP %d", resp.StatusCode)
	}
	return nil
}

func splitAddr(addr string) (name, email string) {
	if i := strings.IndexByte(addr, '<'); i >= 0 {
		name = strings.TrimSpace(addr[:i])
		email = strings.Trim(addr[i:], "<>")
		return
	}
	return "nas-llm", addr
}

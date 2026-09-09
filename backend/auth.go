package main

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	sessionCookie = "nas-llm-session"
	sessionTTL    = 30 * 24 * time.Hour
	magicTokenTTL = 15 * time.Minute
)

// Cookie value: base64url(email) . expUnix . hex(hmac(email|exp)).
func (s *server) setSession(w http.ResponseWriter, email string) {
	exp := time.Now().Add(sessionTTL).Unix()
	mac := hmacSHA256(s.cfg.sessionSecret, email+"|"+strconv.FormatInt(exp, 10))
	val := b64url(email) + "." + strconv.FormatInt(exp, 10) + "." + hex.EncodeToString(mac)
	http.SetCookie(w, &http.Cookie{
		Name: sessionCookie, Value: val, Path: "/",
		Expires: time.Unix(exp, 0), MaxAge: int(sessionTTL.Seconds()),
		HttpOnly: true, Secure: s.cfg.cookieSecure, SameSite: http.SameSiteLaxMode,
	})
}

func (s *server) clearSession(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name: sessionCookie, Value: "", Path: "/",
		MaxAge: -1, HttpOnly: true, Secure: s.cfg.cookieSecure, SameSite: http.SameSiteLaxMode,
	})
}

func (s *server) sessionEmail(r *http.Request) (string, bool) {
	c, err := r.Cookie(sessionCookie)
	if err != nil {
		return "", false
	}
	parts := strings.Split(c.Value, ".")
	if len(parts) != 3 {
		return "", false
	}
	email, err := b64urlDecode(parts[0])
	if err != nil {
		return "", false
	}
	exp, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil {
		return "", false
	}
	if time.Now().Unix() > exp {
		return "", false
	}
	mac, err := hex.DecodeString(parts[2])
	if err != nil {
		return "", false
	}
	want := hmacSHA256(s.cfg.sessionSecret, email+"|"+parts[1])
	if !hmac.Equal(mac, want) {
		return "", false
	}
	return email, true
}

func hmacSHA256(key []byte, data string) []byte {
	h := hmac.New(sha256.New, key)
	h.Write([]byte(data))
	return h.Sum(nil)
}

func b64url(s string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(s))
}

func b64urlDecode(s string) (string, error) {
	b, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

func newMagicToken() (raw string, hash []byte, err error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", nil, err
	}
	raw = hex.EncodeToString(b)
	h := sha256.Sum256([]byte(raw))
	return raw, h[:], nil
}

func hashToken(raw string) []byte {
	h := sha256.Sum256([]byte(raw))
	return h[:]
}

type rateLimiter struct {
	mu   sync.Mutex
	hits map[string][]time.Time
}

func newRateLimiter() *rateLimiter {
	return &rateLimiter{hits: map[string][]time.Time{}}
}

// allow reports whether key has had fewer than max events within window.
func (l *rateLimiter) allow(key string, max int, window time.Duration) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	cutoff := now.Add(-window)
	hits := l.hits[key]
	keep := hits[:0]
	for _, t := range hits {
		if t.After(cutoff) {
			keep = append(keep, t)
		}
	}
	if len(keep) >= max {
		l.hits[key] = keep
		return false
	}
	keep = append(keep, now)
	l.hits[key] = keep
	return true
}

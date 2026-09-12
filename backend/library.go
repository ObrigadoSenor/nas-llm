package main

import (
	"context"
	"fmt"
	"html"
	"io"
	"log"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// libraryModel is one result scraped from ollama.com/search — the full public
// model library. Ollama exposes no official JSON API for browsing the library
// (ollama/ollama#1070, #3922, #9142 are all closed/deferred), so we scrape the
// SSR search page (the NAS backend already does outbound HTTP for pulls) and
// surface name/description/capabilities/sizes/pulls/tags/updated. This lets
// Browse show all available models, not only the hand-curated catalog. Fit
// verdicts are not computed for library models (the KV-cache estimate needs
// known arch dims); capabilities + sizes let the user judge, and a pull
// auto-benchmarks once installed.
type libraryModel struct {
	Name         string   `json:"name"`
	Description  string   `json:"description,omitempty"`
	Capabilities []string `json:"capabilities,omitempty"`
	Sizes        []string `json:"sizes,omitempty"`
	Pulls        string   `json:"pulls,omitempty"`
	Tags         string   `json:"tags,omitempty"`
	Updated      string   `json:"updated,omitempty"`
	URL          string   `json:"url,omitempty"`
}

var (
	// Each result is a <li class="flex items-baseline …">…</li>. Non-greedy with
	// DOTALL so it spans the inline markup. A changed structure simply yields
	// fewer/zero matches — the caller falls back to the curated catalog.
	libLiRe      = regexp.MustCompile(`(?s)<li[^>]*class="flex items-baseline[^"]*"[^>]*>(.*?)</li>`)
	libHrefRe    = regexp.MustCompile(`href="/library/([^"]+)"`)
	libDescRe    = regexp.MustCompile(`(?s)<p class="max-w-lg break-words[^"]*">(.*?)</p>`)
	libSpanRe    = regexp.MustCompile(`<span[^>]*>([^<]*)</span>`)
	libPullsRe   = regexp.MustCompile(`<span[^>]*>([^<]+)</span>\s*<span class="hidden sm:flex">&nbsp;Pulls</span>`)
	libTagsRe    = regexp.MustCompile(`<span[^>]*>([^<]+)</span>\s*<span class="hidden sm:flex">&nbsp;Tags</span>`)
	libUpdatedRe = regexp.MustCompile(`<span class="hidden sm:flex">Updated&nbsp;</span>\s*<span[^>]*>([^<]+)</span>`)
	libSizeRe    = regexp.MustCompile(`(?i)^[0-9.]+(x[0-9.]+)?b$`)
)

func isOllamaCapability(s string) bool {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "tools", "vision", "thinking", "embedding":
		return true
	}
	return false
}

// parseOllamaSearchHTML turns the ollama.com/search HTML body into libraryModel
// entries. Lenient by design: a missing or changed structure yields fewer (or
// zero) results rather than erroring; the caller falls back to the curated
// catalog when the result is empty.
func parseOllamaSearchHTML(body []byte) []libraryModel {
	var out []libraryModel
	for _, m := range libLiRe.FindAllSubmatch(body, -1) {
		block := m[1]
		hm := libHrefRe.FindSubmatch(block)
		if len(hm) < 2 {
			continue
		}
		name := string(hm[1])
		lm := libraryModel{Name: name, URL: "https://ollama.com/library/" + name}
		if dm := libDescRe.FindSubmatch(block); len(dm) >= 2 {
			lm.Description = cleanWebText(html.UnescapeString(string(dm[1])))
		}
		// Classify the tag spans: known capabilities vs size labels (1b/3b/70b/16x17b).
		for _, sm := range libSpanRe.FindAllSubmatch(block, -1) {
			t := strings.TrimSpace(html.UnescapeString(string(sm[1])))
			if t == "" || t == name {
				continue
			}
			if isOllamaCapability(t) {
				lm.Capabilities = append(lm.Capabilities, strings.ToLower(t))
			} else if libSizeRe.MatchString(t) {
				lm.Sizes = append(lm.Sizes, t)
			}
		}
		if pm := libPullsRe.FindSubmatch(block); len(pm) >= 2 {
			lm.Pulls = strings.TrimSpace(html.UnescapeString(string(pm[1])))
		}
		if tm := libTagsRe.FindSubmatch(block); len(tm) >= 2 {
			lm.Tags = strings.TrimSpace(html.UnescapeString(string(tm[1])))
		}
		if um := libUpdatedRe.FindSubmatch(block); len(um) >= 2 {
			lm.Updated = strings.TrimSpace(html.UnescapeString(string(um[1])))
		}
		out = append(out, lm)
	}
	return out
}

func cleanWebText(s string) string {
	s = strings.ReplaceAll(s, "\n", " ")
	return strings.TrimSpace(strings.Join(strings.Fields(s), " "))
}

// scrapeOllamaLibrary fetches ollama.com/search?q=&c=&o= (with a browser
// User-Agent — ollama.com serves SSR HTML to browsers) and parses the result
// list. capability is one of tools/vision/thinking/embedding (ollama.com's
// filter); order is "popular" (default) or "newest".
func scrapeOllamaLibrary(ctx context.Context, q, capability, order string) ([]libraryModel, error) {
	v := url.Values{}
	v.Set("q", strings.TrimSpace(q))
	if c := strings.TrimSpace(strings.ToLower(capability)); isOllamaCapability(c) {
		v.Set("c", c)
	}
	if order == "newest" {
		v.Set("o", "newest")
	}
	u := "https://ollama.com/search?" + v.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
	req.Header.Set("Accept", "text/html,application/xhtml+xml")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("ollama.com unreachable: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("ollama.com search returned %s", resp.Status)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if err != nil {
		return nil, err
	}
	return parseOllamaSearchHTML(body), nil
}

// handleModelLibrary proxies a live search of the full Ollama model library
// (ollama.com/search) as JSON, so Browse can show all available models, not
// only the curated set. Session-auth-gated. On scrape failure it returns 502
// so the frontend can fall back to the curated catalog with a notice.
func (s *server) handleModelLibrary(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 12*time.Second)
	defer cancel()
	models, err := scrapeOllamaLibrary(ctx, r.URL.Query().Get("q"), r.URL.Query().Get("c"), r.URL.Query().Get("o"))
	if err != nil {
		log.Printf("model library scrape: %v", err)
		jsonError(w, "model library unavailable: "+err.Error(), http.StatusBadGateway)
		return
	}
	writeJSON(w, map[string]any{"models": models, "count": len(models)})
}

// --- Per-model tags + download sizes (ollama.com/library/<name>/tags) -------

// libraryTag is one available tag of a library model with its on-disk download
// size, scraped from ollama.com/library/<name>/tags — the only place per-tag
// sizes are published (Ollama exposes no tags API). SizeGB is normalized to
// decimal GB; SizeLabel keeps the page's "1.3GB"/"581MB" string for display.
type libraryTag struct {
	Tag       string  `json:"tag"`
	Model     string  `json:"model"` // full "name:tag"
	SizeGB    float64 `json:"sizeGB"`
	SizeLabel string  `json:"sizeLabel,omitempty"`
	Context   string  `json:"context,omitempty"`
}

var (
	// Each tag row lists the download size bullet-anchored ("• 1.3GB •") in the
	// mobile variant only; the desktop grid cell repeats it without the bullet.
	// Anchoring on the bullet avoids stray "8 mb"-style tokens elsewhere on the
	// page and yields exactly one size per tag, in document order.
	libTagSizeRe = regexp.MustCompile(`•\s*([0-9]+(?:\.[0-9]+)?)\s?(GB|MB|KB)`)
	libTagCtxRe  = regexp.MustCompile(`([0-9]+(?:\.[0-9]+)?[KM]?)\scontext window`)
)

// parseOllamaTagsHTML turns ollama.com/library/<name>/tags HTML into libraryTag
// entries. Each tag row appears twice (mobile + desktop variants sharing one
// href each), so we dedupe consecutive tag hrefs and pair each with the first
// bullet-anchored size that starts after its href. Lenient: a changed layout
// yields fewer (or zero) entries rather than erroring; the caller falls back to
// a default-tag pull when the result is empty.
func parseOllamaTagsHTML(body []byte, modelName string) []libraryTag {
	hrefRe := regexp.MustCompile(`href="/library/` + regexp.QuoteMeta(modelName) + `:([^"]+)"`)
	hrefIdx := hrefRe.FindAllSubmatchIndex(body, -1)
	sizeIdx := libTagSizeRe.FindAllSubmatchIndex(body, -1)
	ctxIdx := libTagCtxRe.FindAllSubmatchIndex(body, -1)
	out := make([]libraryTag, 0, len(hrefIdx)/2)
	si, ci := 0, 0
	last := ""
	for _, h := range hrefIdx {
		tag := string(body[h[2]:h[3]])
		if tag == last { // skip the desktop-variant duplicate of the same tag
			continue
		}
		last = tag
		lt := libraryTag{Tag: tag, Model: modelName + ":" + tag}
		for si < len(sizeIdx) && sizeIdx[si][0] < h[1] {
			si++
		}
		if si < len(sizeIdx) {
			numStr := string(body[sizeIdx[si][2]:sizeIdx[si][3]])
			unitStr := string(body[sizeIdx[si][4]:sizeIdx[si][5]])
			lt.SizeLabel = numStr + unitStr
			if num, err := strconv.ParseFloat(numStr, 64); err == nil {
				switch unitStr {
				case "GB":
					lt.SizeGB = num
				case "MB":
					lt.SizeGB = num / 1024
				case "KB":
					lt.SizeGB = num / (1024 * 1024)
				}
			}
			si++
		}
		for ci < len(ctxIdx) && ctxIdx[ci][0] < h[1] {
			ci++
		}
		if ci < len(ctxIdx) {
			lt.Context = string(body[ctxIdx[ci][2]:ctxIdx[ci][3]])
			ci++
		}
		out = append(out, lt)
	}
	return out
}

// scrapeOllamaModelTags fetches ollama.com/library/<name>/tags and parses the
// per-tag list with download sizes. Used by Browse's Download menu so the user
// can pick a specific size/quant before pulling. A name carrying a tag
// ("llama3.2:1b") is reduced to its base model; only the base has a tags page.
func scrapeOllamaModelTags(ctx context.Context, name string) ([]libraryTag, error) {
	name = strings.TrimSpace(name)
	if i := strings.Index(name, ":"); i >= 0 {
		name = name[:i] // strip an incidental tag; the tags page is per base model
	}
	if name == "" {
		return nil, fmt.Errorf("model name required")
	}
	u := "https://ollama.com/library/" + url.PathEscape(name) + "/tags"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
	req.Header.Set("Accept", "text/html,application/xhtml+xml")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("ollama.com unreachable: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("ollama.com tags returned %s", resp.Status)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if err != nil {
		return nil, err
	}
	return parseOllamaTagsHTML(body, name), nil
}

// handleModelLibraryTags returns the available tags + download sizes for one
// library model, scraped from ollama.com/library/<name>/tags. Session-auth-
// gated. On scrape failure returns 502 so the frontend can fall back to a
// default-tag pull.
func (s *server) handleModelLibraryTags(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimSpace(r.URL.Query().Get("name"))
	if name == "" {
		jsonError(w, "name is required", http.StatusBadRequest)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 12*time.Second)
	defer cancel()
	tags, err := scrapeOllamaModelTags(ctx, name)
	if err != nil {
		log.Printf("model tags scrape: %v", err)
		jsonError(w, "model tags unavailable: "+err.Error(), http.StatusBadGateway)
		return
	}
	writeJSON(w, map[string]any{"name": name, "tags": tags})
}

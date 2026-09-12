package main

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
	// Images holds base64 data URLs attached to a vision turn (e.g. gemma3:4b).
	// Empty for text-only messages, so existing stored conversations round-trip
	// unchanged. Persisted inline in the messages JSON blob.
	Images []string    `json:"images,omitempty"`
	Ts     int64       `json:"ts,omitempty"`
	Search *searchMeta `json:"search,omitempty"`
	// Clarify, when set on an assistant turn, marks it as a clarifying question
	// from the agent loop and carries the structured question/options card for
	// the UI. The question text is also stored in Content so the model has
	// context for the user's follow-up answer on the next round. Rides in the
	// messages JSON blob; omitempty keeps existing rows byte-identical.
	Clarify *clarifyMeta `json:"clarify,omitempty"`
	// Steps, when set on an assistant turn, is the agent's tool-call trace
	// (one entry per tool call): tool name, args, a short result preview, and
	// specialized payloads (search evidence, clarify card). Rides in the
	// messages JSON blob so a reload re-paints the trace; omitempty keeps
	// existing rows byte-identical. Populated only for agent-mode turns.
	Steps []agentStep `json:"steps,omitempty"`
	// Thoughts, when set on an assistant turn, is the agent's per-round reasoning
	// text (one entry per thinking round) shown in a smaller collapsible drawer
	// above the answer. Rides in the messages JSON blob so a reload re-paints it;
	// omitempty keeps existing rows byte-identical. Populated only for agent-mode
	// turns where the model reasoned across multiple tool-calling rounds.
	Thoughts []string `json:"thoughts,omitempty"`
}

type Conversation struct {
	ID          string    `json:"id"`
	Title       string    `json:"title"`
	Model       string    `json:"model"`
	FolderID    string    `json:"folderId,omitempty"`
	RepoID      string    `json:"repoId,omitempty"`
	RepoBranch  string    `json:"repoBranch,omitempty"`
	TitleCustom bool      `json:"titleCustom"`
	CreatedAt   int64     `json:"createdAt"`
	UpdatedAt   int64     `json:"updatedAt"`
	Messages    []Message `json:"messages,omitempty"`
}

type Folder struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Position  int    `json:"position"`
	CreatedAt int64  `json:"createdAt"`
}

// Repo is a locally-cloned repository registered with the backend. The desktop
// sidecar pushes this context (branch, HEAD, top-level tree) on clone/open so
// the agent loop can inject it into the system prompt for repo-bound chats.
type Repo struct {
	ID        string   `json:"id"`
	Email     string   `json:"-"`
	FullName  string   `json:"fullName"`
	LocalPath string   `json:"localPath"`
	Branch    string   `json:"branch"`
	Head      string   `json:"head"`
	Tree      []string `json:"tree"`
	CreatedAt int64    `json:"createdAt"`
}

type store struct {
	db *sql.DB
}

func newStore(path string) (*store, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	// SQLite serializes on a single conn; one writer avoids "database is locked".
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(`PRAGMA journal_mode=WAL;`); err != nil {
		return nil, err
	}
	if _, err := db.Exec(`PRAGMA busy_timeout=5000;`); err != nil {
		return nil, err
	}
	const schema = `
CREATE TABLE IF NOT EXISTS users (
	email TEXT PRIMARY KEY,
	created_at INTEGER NOT NULL,
	last_login_at INTEGER
);
CREATE TABLE IF NOT EXISTS magic_tokens (
	token_hash BLOB PRIMARY KEY,
	email TEXT NOT NULL,
	expires_at INTEGER NOT NULL,
	used_at INTEGER
);
CREATE TABLE IF NOT EXISTS conversations (
	id TEXT PRIMARY KEY,
	email TEXT NOT NULL,
	title TEXT NOT NULL,
	model TEXT NOT NULL,
	folder_id TEXT,
	title_custom INTEGER NOT NULL DEFAULT 0,
	agent_system TEXT,
	agent_tools TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	messages TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conv_email_updated ON conversations(email, updated_at);
CREATE TABLE IF NOT EXISTS folders (
	id TEXT PRIMARY KEY,
	email TEXT NOT NULL,
	name TEXT NOT NULL,
	position INTEGER NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_folders_email_pos ON folders(email, position);
CREATE TABLE IF NOT EXISTS jobs (
	id TEXT PRIMARY KEY,
	conversation_id TEXT NOT NULL,
	email TEXT NOT NULL,
	status TEXT NOT NULL,
	model TEXT NOT NULL,
	web_search INTEGER NOT NULL DEFAULT 0,
	content TEXT NOT NULL DEFAULT '',
	error TEXT NOT NULL DEFAULT '',
	prompt_tokens INTEGER NOT NULL DEFAULT 0,
	completion_tokens INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL,
	started_at INTEGER,
	finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_jobs_conv ON jobs(conversation_id);
CREATE TABLE IF NOT EXISTS agent_steps (
	job_id TEXT NOT NULL,
	step INTEGER NOT NULL,
	tool TEXT NOT NULL,
	args TEXT NOT NULL DEFAULT '',
	result_preview TEXT NOT NULL DEFAULT '',
	duration_ms INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_steps_job ON agent_steps(job_id, step);
CREATE TABLE IF NOT EXISTS notes (
	id TEXT PRIMARY KEY,
	email TEXT NOT NULL,
	key TEXT NOT NULL,
	value TEXT NOT NULL,
	updated_at INTEGER NOT NULL,
	UNIQUE(email, key)
);
CREATE TABLE IF NOT EXISTS settings (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS model_benchmarks (
	model TEXT PRIMARY KEY,
	tok_per_sec REAL NOT NULL DEFAULT 0,
	prompt_tok_per_sec REAL NOT NULL DEFAULT 0,
	load_ms INTEGER NOT NULL DEFAULT 0,
	evaluated_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS repos (
	id TEXT PRIMARY KEY,
	email TEXT NOT NULL,
	full_name TEXT NOT NULL,
	local_path TEXT NOT NULL DEFAULT '',
	branch TEXT NOT NULL DEFAULT '',
	head TEXT NOT NULL DEFAULT '',
	tree TEXT NOT NULL DEFAULT '[]',
	created_at INTEGER NOT NULL,
	UNIQUE(email, full_name)
);
CREATE INDEX IF NOT EXISTS idx_repos_email ON repos(email);
`
	if _, err := db.Exec(schema); err != nil {
		return nil, fmt.Errorf("schema: %w", err)
	}
	if err := migrate(db); err != nil {
		return nil, fmt.Errorf("migrate: %w", err)
	}
	if err := reconcileJobs(db); err != nil {
		return nil, fmt.Errorf("reconcile jobs: %w", err)
	}
	return &store{db: db}, nil
}

// upsertBenchmark records (or replaces) the last measured benchmark for a model.
func (s *store) upsertBenchmark(model string, tokPerSec, promptTokPerSec float64, loadMs int64) error {
	_, err := s.db.Exec(`INSERT INTO model_benchmarks(model, tok_per_sec, prompt_tok_per_sec, load_ms, evaluated_at)
		VALUES(?, ?, ?, ?, ?)
		ON CONFLICT(model) DO UPDATE SET tok_per_sec=excluded.tok_per_sec,
			prompt_tok_per_sec=excluded.prompt_tok_per_sec, load_ms=excluded.load_ms,
			evaluated_at=excluded.evaluated_at`,
		model, tokPerSec, promptTokPerSec, loadMs, time.Now().UnixMilli())
	return err
}

// getBenchmark returns the last measured benchmark for a model, or nil if none.
func (s *store) getBenchmark(model string) *benchmark {
	var b benchmark
	var tok, ptok float64
	var loadMs int64
	err := s.db.QueryRow(`SELECT tok_per_sec, prompt_tok_per_sec, load_ms, evaluated_at FROM model_benchmarks WHERE model = ?`, model).
		Scan(&tok, &ptok, &loadMs, &b.EvaluatedAt)
	if err != nil {
		return nil
	}
	b.Model = model
	b.TokPerSec = tok
	b.PromptTokPerSec = ptok
	b.LoadMs = loadMs
	return &b
}

// migrate adds columns to pre-existing tables (a no-op for fresh installs,
// which already include them via the schema above).
func migrate(db *sql.DB) error {
	cols, err := tableColumns(db, "conversations")
	if err != nil {
		return err
	}
	if !cols["folder_id"] {
		if _, err := db.Exec(`ALTER TABLE conversations ADD COLUMN folder_id TEXT`); err != nil {
			return err
		}
	}
	if !cols["title_custom"] {
		if _, err := db.Exec(`ALTER TABLE conversations ADD COLUMN title_custom INTEGER NOT NULL DEFAULT 0`); err != nil {
			return err
		}
	}
	if !cols["agent_system"] {
		if _, err := db.Exec(`ALTER TABLE conversations ADD COLUMN agent_system TEXT`); err != nil {
			return err
		}
	}
	if !cols["agent_tools"] {
		if _, err := db.Exec(`ALTER TABLE conversations ADD COLUMN agent_tools TEXT`); err != nil {
			return err
		}
	}
	jcols, err := tableColumns(db, "jobs")
	if err != nil {
		return err
	}
	if !jcols["prompt_tokens"] {
		if _, err := db.Exec(`ALTER TABLE jobs ADD COLUMN prompt_tokens INTEGER NOT NULL DEFAULT 0`); err != nil {
			return err
		}
	}
	if !jcols["completion_tokens"] {
		if _, err := db.Exec(`ALTER TABLE jobs ADD COLUMN completion_tokens INTEGER NOT NULL DEFAULT 0`); err != nil {
			return err
		}
	}
	if !cols["repo_id"] {
		if _, err := db.Exec(`ALTER TABLE conversations ADD COLUMN repo_id TEXT`); err != nil {
			return err
		}
	}
	if !cols["repo_branch"] {
		if _, err := db.Exec(`ALTER TABLE conversations ADD COLUMN repo_branch TEXT`); err != nil {
			return err
		}
	}
	return nil
}

func tableColumns(db *sql.DB, table string) (map[string]bool, error) {
	rows, err := db.Query(fmt.Sprintf(`PRAGMA table_info(%s)`, table))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	cols := map[string]bool{}
	for rows.Next() {
		var cid, notnull, pk int
		var name, ctype string
		var dflt sql.NullString
		if err := rows.Scan(&cid, &name, &ctype, &notnull, &dflt, &pk); err != nil {
			return nil, err
		}
		cols[name] = true
	}
	return cols, rows.Err()
}

func (s *store) close() error { return s.db.Close() }

func (s *store) upsertUser(email string) error {
	_, err := s.db.Exec(`INSERT INTO users(email, created_at) VALUES(?, ?)
		ON CONFLICT(email) DO NOTHING`, email, time.Now().UnixMilli())
	return err
}

func (s *store) addMagicToken(email string, hash []byte, expiresAt int64) error {
	_, err := s.db.Exec(`INSERT INTO magic_tokens(token_hash, email, expires_at) VALUES(?, ?, ?)`,
		hash, email, expiresAt)
	return err
}

// verifyMagicToken looks up the token, rejects used/expired ones, marks it used,
// and stamps last_login. Returns ("", nil) when the token is invalid/expired.
func (s *store) verifyMagicToken(hash []byte) (string, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return "", err
	}
	defer tx.Rollback()
	var email string
	var expiresAt int64
	var usedAt sql.NullInt64
	err = tx.QueryRow(`SELECT email, expires_at, used_at FROM magic_tokens WHERE token_hash = ?`, hash).
		Scan(&email, &expiresAt, &usedAt)
	if err == sql.ErrNoRows {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if usedAt.Valid || time.Now().UnixMilli() > expiresAt {
		return "", nil
	}
	if _, err = tx.Exec(`UPDATE magic_tokens SET used_at = ? WHERE token_hash = ?`, time.Now().UnixMilli(), hash); err != nil {
		return "", err
	}
	if _, err = tx.Exec(`UPDATE users SET last_login_at = ? WHERE email = ?`, time.Now().UnixMilli(), email); err != nil {
		return "", err
	}
	if err := tx.Commit(); err != nil {
		return "", err
	}
	return email, nil
}

func (s *store) newConversationID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("%x", time.Now().UnixNano())
	}
	return hex.EncodeToString(b)
}

func (s *store) listConversations(email string) ([]Conversation, error) {
	rows, err := s.db.Query(`SELECT id, title, model, folder_id, repo_id, repo_branch, title_custom, created_at, updated_at FROM conversations WHERE email = ? ORDER BY updated_at DESC`, email)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Conversation
	for rows.Next() {
		var c Conversation
		var folderID, repoID, repoBranch sql.NullString
		var titleCustom int
		if err := rows.Scan(&c.ID, &c.Title, &c.Model, &folderID, &repoID, &repoBranch, &titleCustom, &c.CreatedAt, &c.UpdatedAt); err != nil {
			return nil, err
		}
		c.FolderID = folderID.String
		c.RepoID = repoID.String
		c.RepoBranch = repoBranch.String
		c.TitleCustom = titleCustom != 0
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s *store) getConversation(email, id string) (*Conversation, error) {
	var c Conversation
	var msgs string
	var folderID, repoID, repoBranch sql.NullString
	var titleCustom int
	err := s.db.QueryRow(`SELECT id, title, model, folder_id, repo_id, repo_branch, title_custom, created_at, updated_at, messages FROM conversations WHERE id = ? AND email = ?`, id, email).
		Scan(&c.ID, &c.Title, &c.Model, &folderID, &repoID, &repoBranch, &titleCustom, &c.CreatedAt, &c.UpdatedAt, &msgs)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	c.FolderID = folderID.String
	c.RepoID = repoID.String
	c.RepoBranch = repoBranch.String
	c.TitleCustom = titleCustom != 0
	if err := json.Unmarshal([]byte(msgs), &c.Messages); err != nil {
		return nil, err
	}
	return &c, nil
}

func (s *store) createConversation(email, id, title, model string, msgs []Message) (*Conversation, error) {
	now := time.Now().UnixMilli()
	j, err := json.Marshal(msgs)
	if err != nil {
		return nil, err
	}
	if _, err := s.db.Exec(`INSERT INTO conversations(id, email, title, model, created_at, updated_at, messages) VALUES(?, ?, ?, ?, ?, ?, ?)`,
		id, email, title, model, now, now, string(j)); err != nil {
		return nil, err
	}
	return &Conversation{ID: id, Title: title, Model: model, CreatedAt: now, UpdatedAt: now, Messages: msgs}, nil
}

func (s *store) updateConversation(email, id, title, model string, msgs []Message) (*Conversation, error) {
	now := time.Now().UnixMilli()
	j, err := json.Marshal(msgs)
	if err != nil {
		return nil, err
	}
	// Preserve a user-renamed title: if the conversation was renamed, keep the
	// stored title and ignore the auto-derived one the client sends each turn.
	var titleCustom int
	if e := s.db.QueryRow(`SELECT title_custom FROM conversations WHERE id = ? AND email = ?`, id, email).Scan(&titleCustom); e != nil && e != sql.ErrNoRows {
		return nil, e
	}
	var res sql.Result
	if titleCustom != 0 {
		res, err = s.db.Exec(`UPDATE conversations SET model = ?, messages = ?, updated_at = ? WHERE id = ? AND email = ?`,
			model, string(j), now, id, email)
	} else {
		res, err = s.db.Exec(`UPDATE conversations SET title = ?, model = ?, messages = ?, updated_at = ? WHERE id = ? AND email = ?`,
			title, model, string(j), now, id, email)
	}
	if err != nil {
		return nil, err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return nil, nil
	}
	return s.getConversation(email, id)
}

func (s *store) deleteConversation(email, id string) (bool, error) {
	res, err := s.db.Exec(`DELETE FROM conversations WHERE id = ? AND email = ?`, id, email)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

func (s *store) newFolderID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("%x", time.Now().UnixNano())
	}
	return hex.EncodeToString(b)
}

func (s *store) listFolders(email string) ([]Folder, error) {
	rows, err := s.db.Query(`SELECT id, name, position, created_at FROM folders WHERE email = ? ORDER BY position ASC, created_at ASC`, email)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Folder
	for rows.Next() {
		var f Folder
		if err := rows.Scan(&f.ID, &f.Name, &f.Position, &f.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

func (s *store) createFolder(email, name string) (*Folder, error) {
	var pos int
	if e := s.db.QueryRow(`SELECT COALESCE(MAX(position),-1)+1 FROM folders WHERE email = ?`, email).Scan(&pos); e != nil && e != sql.ErrNoRows {
		return nil, e
	}
	id := s.newFolderID()
	now := time.Now().UnixMilli()
	if _, err := s.db.Exec(`INSERT INTO folders(id, email, name, position, created_at) VALUES(?, ?, ?, ?, ?)`, id, email, name, pos, now); err != nil {
		return nil, err
	}
	return &Folder{ID: id, Name: name, Position: pos, CreatedAt: now}, nil
}

func (s *store) renameFolder(email, id, name string) (*Folder, error) {
	res, err := s.db.Exec(`UPDATE folders SET name = ? WHERE id = ? AND email = ?`, name, id, email)
	if err != nil {
		return nil, err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return nil, nil
	}
	var f Folder
	if err := s.db.QueryRow(`SELECT id, name, position, created_at FROM folders WHERE id = ?`, id).Scan(&f.ID, &f.Name, &f.Position, &f.CreatedAt); err != nil {
		return nil, err
	}
	return &f, nil
}

func (s *store) deleteFolder(email, id string) (bool, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`UPDATE conversations SET folder_id = NULL WHERE folder_id = ? AND email = ?`, id, email); err != nil {
		return false, err
	}
	res, err := tx.Exec(`DELETE FROM folders WHERE id = ? AND email = ?`, id, email)
	if err != nil {
		return false, err
	}
	if err := tx.Commit(); err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// patchConversation applies a partial update; nil fields are left unchanged.
// An empty folderID clears the folder (sets it to NULL). A non-empty title marks
// the conversation as having a custom title (title_custom = 1) so later saves
// won't overwrite it with the auto-derived first-message title.
func (s *store) patchConversation(email, id string, title, folderID, model, agentSystem, agentTools, repoID, repoBranch *string) (*Conversation, error) {
	now := time.Now().UnixMilli()
	sets := []string{"updated_at = ?"}
	args := []any{now}
	if title != nil {
		sets = append(sets, "title = ?", "title_custom = 1")
		args = append(args, *title)
	}
	if folderID != nil {
		if *folderID == "" {
			sets = append(sets, "folder_id = NULL")
		} else {
			sets = append(sets, "folder_id = ?")
			args = append(args, *folderID)
		}
	}
	if model != nil {
		sets = append(sets, "model = ?")
		args = append(args, *model)
	}
	if agentSystem != nil {
		sets = append(sets, "agent_system = ?")
		args = append(args, *agentSystem)
	}
	if agentTools != nil {
		sets = append(sets, "agent_tools = ?")
		args = append(args, *agentTools)
	}
	if repoID != nil {
		if *repoID == "" {
			sets = append(sets, "repo_id = NULL")
		} else {
			sets = append(sets, "repo_id = ?")
			args = append(args, *repoID)
		}
	}
	if repoBranch != nil {
		if *repoBranch == "" {
			sets = append(sets, "repo_branch = NULL")
		} else {
			sets = append(sets, "repo_branch = ?")
			args = append(args, *repoBranch)
		}
	}
	args = append(args, id, email)
	res, err := s.db.Exec(`UPDATE conversations SET `+strings.Join(sets, ", ")+` WHERE id = ? AND email = ?`, args...)
	if err != nil {
		return nil, err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return nil, nil
	}
	return s.getConversation(email, id)
}

// --- Jobs (background generation) ---

// updateConversationMessages replaces a conversation's model + messages without
// touching the title (used by the generate endpoint to persist the user's turn).
func (s *store) updateConversationMessages(email, id, model string, msgs []Message) error {
	now := time.Now().UnixMilli()
	j, err := json.Marshal(msgs)
	if err != nil {
		return err
	}
	res, err := s.db.Exec(`UPDATE conversations SET model = ?, messages = ?, updated_at = ? WHERE id = ? AND email = ?`,
		model, string(j), now, id, email)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fmt.Errorf("conversation not found")
	}
	return nil
}

// appendAssistantMessage reads the current messages, appends one assistant
// message, and writes them back. The title is preserved. Called by the job
// worker when generation finishes.
func (s *store) appendAssistantMessage(email, id string, msg Message) error {
	var msgsJSON string
	err := s.db.QueryRow(`SELECT messages FROM conversations WHERE id = ? AND email = ?`, id, email).Scan(&msgsJSON)
	if err != nil {
		return err
	}
	var msgs []Message
	if err := json.Unmarshal([]byte(msgsJSON), &msgs); err != nil {
		return err
	}
	msgs = append(msgs, msg)
	j, err := json.Marshal(msgs)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(`UPDATE conversations SET messages = ?, updated_at = ? WHERE id = ? AND email = ?`,
		string(j), msg.Ts, id, email)
	return err
}

func (s *store) createJob(j *job) error {
	ws := 0
	if j.webSearch {
		ws = 1
	}
	_, err := s.db.Exec(`INSERT INTO jobs(id, conversation_id, email, status, model, web_search, content, error, created_at)
		VALUES(?, ?, ?, 'queued', ?, ?, '', '', ?)`,
		j.id, j.convID, j.email, j.model, ws, j.createdAt)
	return err
}

func (s *store) setJobGenerating(id string) error {
	_, err := s.db.Exec(`UPDATE jobs SET status = 'generating', started_at = ? WHERE id = ?`, time.Now().UnixMilli(), id)
	return err
}

func (s *store) setJobContent(id, content string) error {
	_, err := s.db.Exec(`UPDATE jobs SET content = ? WHERE id = ?`, content, id)
	return err
}

func (s *store) finalizeJob(id, status, errMsg string, finishedAt int64) error {
	_, err := s.db.Exec(`UPDATE jobs SET status = ?, error = ?, finished_at = ? WHERE id = ?`, status, errMsg, finishedAt, id)
	return err
}

// reconcileJobs marks any jobs left queued/generating by a prior backend run as
// errored. An in-memory job cannot survive a process restart, so partial work is
// abandoned and the user re-sends.
func reconcileJobs(db *sql.DB) error {
	_, err := db.Exec(`UPDATE jobs SET status = 'error', error = 'backend restarted', finished_at = ?
		WHERE status IN ('queued', 'generating')`, time.Now().UnixMilli())
	return err
}

// setJobTokens records the cumulative prompt/completion token counts for a job
// (agent-mode observability). Ollama reports usage per round; the agent loop
// accumulates it and the worker persists the totals here.
func (s *store) setJobTokens(id string, prompt, completion int) error {
	_, err := s.db.Exec(`UPDATE jobs SET prompt_tokens = ?, completion_tokens = ? WHERE id = ?`, prompt, completion, id)
	return err
}

// --- Agent observability (agent_steps) --------------------------------------

// addAgentStep persists one row of an agent run's tool-call trace. The
// user-facing trace also rides on the assistant message (Message.Steps); this
// table is the normalized, queryable store for per-run analytics.
func (s *store) addAgentStep(jobID string, st agentStep) error {
	preview := st.Preview
	if len(preview) > 500 {
		preview = preview[:500]
	}
	_, err := s.db.Exec(`INSERT INTO agent_steps(job_id, step, tool, args, result_preview, duration_ms, created_at)
		VALUES(?, ?, ?, ?, ?, ?, ?)`,
		jobID, st.Step, st.Tool, st.Args, preview, st.DurationMs, time.Now().UnixMilli())
	return err
}

// PersistAgentSteps writes all of a job's trace rows in one call (worker uses
// this after a run finalizes).
func (s *store) persistAgentSteps(jobID string, steps []agentStep) error {
	for _, st := range steps {
		if err := s.addAgentStep(jobID, st); err != nil {
			return err
		}
	}
	return nil
}

// --- Memory (notes) --------------------------------------------------------

// getNote returns the value for a (email,key) note, or "" with ok=false if none.
func (s *store) getNote(email, key string) (string, bool, error) {
	var v string
	err := s.db.QueryRow(`SELECT value FROM notes WHERE email = ? AND key = ?`, email, key).Scan(&v)
	if err == sql.ErrNoRows {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return v, true, nil
}

// setNote upserts a (email,key) note.
func (s *store) setNote(email, key, value string) error {
	id := s.newFolderID()
	_, err := s.db.Exec(`INSERT INTO notes(id, email, key, value, updated_at) VALUES(?, ?, ?, ?, ?)
		ON CONFLICT(email, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
		id, email, key, value, time.Now().UnixMilli())
	return err
}

// listNoteKeys returns the distinct keys for a user, for the memory index
// injected into the agent system prompt.
func (s *store) listNoteKeys(email string) ([]string, error) {
	rows, err := s.db.Query(`SELECT key FROM notes WHERE email = ? ORDER BY key ASC`, email)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var k string
		if err := rows.Scan(&k); err != nil {
			return nil, err
		}
		out = append(out, k)
	}
	return out, rows.Err()
}

// --- Settings (global agent config) ----------------------------------------

func (s *store) getSetting(key string) string {
	var v string
	if err := s.db.QueryRow(`SELECT value FROM settings WHERE key = ?`, key).Scan(&v); err != nil {
		return ""
	}
	return v
}

func (s *store) setSetting(key, value string) error {
	_, err := s.db.Exec(`INSERT INTO settings(key, value) VALUES(?, ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, value)
	return err
}

// --- Per-conversation agent config -----------------------------------------

// getConvAgentConfig returns the (system prompt, tool allowlist) override for a
// conversation. Empty strings mean "no override"; the caller falls back to
// global settings then built-in defaults.
func (s *store) getConvAgentConfig(email, id string) (system, tools string, err error) {
	var sys, t sql.NullString
	err = s.db.QueryRow(`SELECT agent_system, agent_tools FROM conversations WHERE id = ? AND email = ?`, id, email).Scan(&sys, &t)
	if err == sql.ErrNoRows {
		return "", "", nil
	}
	if err != nil {
		return "", "", err
	}
	return sys.String, t.String, nil
}

// getConvRepoID returns the repo_id bound to a conversation ("" if none).
func (s *store) getConvRepoID(email, id string) (string, error) {
	var repoID sql.NullString
	err := s.db.QueryRow(`SELECT repo_id FROM conversations WHERE id = ? AND email = ?`, id, email).Scan(&repoID)
	if err == sql.ErrNoRows {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return repoID.String, nil
}

// --- Repos (locally-cloned codebases) --------------------------------------

// upsertRepo registers or updates a repo for a user. The desktop sidecar pushes
// this on clone/open so the agent loop can inject repo context into the system
// prompt. Keyed by (email, full_name) so re-pushing refreshes branch/head/tree.
func (s *store) upsertRepo(email string, r *Repo) (*Repo, error) {
	id := s.newFolderID() // reuse the random-ID helper
	now := time.Now().UnixMilli()
	treeJSON, _ := json.Marshal(r.Tree)
	// Try insert; on conflict (email, full_name), update in place and keep the id.
	res, err := s.db.Exec(`INSERT INTO repos(id, email, full_name, local_path, branch, head, tree, created_at)
		VALUES(?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(email, full_name) DO UPDATE SET local_path=excluded.local_path,
			branch=excluded.branch, head=excluded.head, tree=excluded.tree`,
		id, email, r.FullName, r.LocalPath, r.Branch, r.Head, string(treeJSON), now)
	if err != nil {
		return nil, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		// ON CONFLICT DO UPDATE still reports 1 row affected in SQLite, so this is
		// just a safety net. Fetch the existing id by (email, full_name).
	}
	var existingID string
	if err := s.db.QueryRow(`SELECT id FROM repos WHERE email = ? AND full_name = ?`, email, r.FullName).Scan(&existingID); err != nil {
		return nil, err
	}
	r.ID = existingID
	r.Email = email
	r.CreatedAt = now
	return r, nil
}

// listRepos returns all repos registered by a user.
func (s *store) listRepos(email string) ([]Repo, error) {
	rows, err := s.db.Query(`SELECT id, full_name, local_path, branch, head, tree, created_at FROM repos WHERE email = ? ORDER BY created_at DESC`, email)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Repo
	for rows.Next() {
		var r Repo
		var treeJSON string
		if err := rows.Scan(&r.ID, &r.FullName, &r.LocalPath, &r.Branch, &r.Head, &treeJSON, &r.CreatedAt); err != nil {
			return nil, err
		}
		_ = json.Unmarshal([]byte(treeJSON), &r.Tree)
		out = append(out, r)
	}
	return out, rows.Err()
}

// getRepo returns a single repo by id, or nil if not found / not owned by email.
func (s *store) getRepo(email, id string) (*Repo, error) {
	var r Repo
	var treeJSON string
	err := s.db.QueryRow(`SELECT id, full_name, local_path, branch, head, tree, created_at FROM repos WHERE id = ? AND email = ?`, id, email).
		Scan(&r.ID, &r.FullName, &r.LocalPath, &r.Branch, &r.Head, &treeJSON, &r.CreatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	_ = json.Unmarshal([]byte(treeJSON), &r.Tree)
	r.Email = email
	return &r, nil
}

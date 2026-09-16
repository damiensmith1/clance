import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "fs";
import { join } from "path";
import { SESSION_CWD } from "./paths";

// Node's built-in SQLite rather than better-sqlite3 (see docs/dictation.md):
// verified working in Electron 44's Node 24.20, including FTS5, which means
// no second native addon to rebuild against Electron's ABI on every bump —
// node-pty is already enough of that. It's still flagged experimental
// upstream, so every statement in the app goes through this one module; a
// swap to another engine is a change to this file and nothing else.
const DB_PATH = join(SESSION_CWD, "dictation.db");
const SCHEMA_VERSION = 1;

export type Transcript = {
  id: number;
  text: string;
  createdAt: number;
  durationMs: number;
  transcribeMs: number;
  model: string;
  targetApp: string | null;
  inserted: boolean;
};

let db: DatabaseSync | undefined;

function migrate(database: DatabaseSync): void {
  const { user_version: version } = database.prepare("PRAGMA user_version").get() as {
    user_version: number;
  };
  if (version >= SCHEMA_VERSION) return;

  if (version < 1) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS transcripts (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        text          TEXT    NOT NULL,
        created_at    INTEGER NOT NULL,
        duration_ms   INTEGER NOT NULL,
        transcribe_ms INTEGER NOT NULL,
        model         TEXT    NOT NULL,
        target_app    TEXT,
        inserted      INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_transcripts_created_at
        ON transcripts(created_at DESC);

      CREATE VIRTUAL TABLE IF NOT EXISTS transcripts_fts USING fts5(
        text, content='transcripts', content_rowid='id'
      );

      -- External-content FTS5 doesn't track its base table on its own, so
      -- deletes and edits have to push the old row out of the index too.
      -- Without the delete trigger a removed transcript would keep turning
      -- up in search, which for a log of things the user actually said is
      -- the one bug worth being careful about.
      CREATE TRIGGER IF NOT EXISTS transcripts_ai AFTER INSERT ON transcripts BEGIN
        INSERT INTO transcripts_fts(rowid, text) VALUES (new.id, new.text);
      END;
      CREATE TRIGGER IF NOT EXISTS transcripts_ad AFTER DELETE ON transcripts BEGIN
        INSERT INTO transcripts_fts(transcripts_fts, rowid, text)
          VALUES ('delete', old.id, old.text);
      END;
      CREATE TRIGGER IF NOT EXISTS transcripts_au AFTER UPDATE ON transcripts BEGIN
        INSERT INTO transcripts_fts(transcripts_fts, rowid, text)
          VALUES ('delete', old.id, old.text);
        INSERT INTO transcripts_fts(rowid, text) VALUES (new.id, new.text);
      END;
    `);
  }

  database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

function open(): DatabaseSync {
  if (db) return db;
  mkdirSync(SESSION_CWD, { recursive: true });
  const database = new DatabaseSync(DB_PATH);
  // WAL so a long read (a search over a big history) can't block the write
  // that a just-finished dictation needs to make.
  database.exec("PRAGMA journal_mode = WAL");
  migrate(database);
  db = database;
  return db;
}

type Row = {
  id: number;
  text: string;
  created_at: number;
  duration_ms: number;
  transcribe_ms: number;
  model: string;
  target_app: string | null;
  inserted: number;
};

function toTranscript(row: Row): Transcript {
  return {
    id: row.id,
    text: row.text,
    createdAt: row.created_at,
    durationMs: row.duration_ms,
    transcribeMs: row.transcribe_ms,
    model: row.model,
    targetApp: row.target_app,
    inserted: row.inserted === 1,
  };
}

export function addTranscript(entry: Omit<Transcript, "id">): Transcript {
  const database = open();
  const result = database
    .prepare(
      `INSERT INTO transcripts (text, created_at, duration_ms, transcribe_ms, model, target_app, inserted)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      entry.text,
      entry.createdAt,
      entry.durationMs,
      entry.transcribeMs,
      entry.model,
      entry.targetApp,
      entry.inserted ? 1 : 0
    );
  return { ...entry, id: Number(result.lastInsertRowid) };
}

export function listTranscripts(limit = 100, offset = 0): Transcript[] {
  const database = open();
  const rows = database
    .prepare(
      `SELECT * FROM transcripts ORDER BY created_at DESC LIMIT ? OFFSET ?`
    )
    .all(limit, offset) as Row[];
  return rows.map(toTranscript);
}

/**
 * Full-text search over history.
 *
 * The query is turned into a quoted prefix match per term rather than
 * passed through: FTS5's MATCH syntax treats characters users type all the
 * time (`-`, `"`, `*`, `:`, `NEAR`) as operators, so a raw query like
 * `node-pty` is a syntax error that would surface as a broken search box.
 * Quoting each term makes it a literal, and the trailing `*` keeps search
 * responsive as the user types.
 */
export function searchTranscripts(query: string, limit = 100): Transcript[] {
  const database = open();
  const terms = query
    .split(/\s+/)
    .map((t) => t.replace(/"/g, ""))
    .filter((t) => t.length > 0);
  if (terms.length === 0) return listTranscripts(limit);

  const matchExpr = terms.map((t) => `"${t}"*`).join(" ");
  try {
    const rows = database
      .prepare(
        `SELECT t.* FROM transcripts t
           JOIN transcripts_fts f ON f.rowid = t.id
          WHERE transcripts_fts MATCH ?
          ORDER BY t.created_at DESC
          LIMIT ?`
      )
      .all(matchExpr, limit) as Row[];
    return rows.map(toTranscript);
  } catch {
    // Any residual MATCH-syntax surprise degrades to a plain substring
    // scan rather than an empty result the user can't explain.
    const rows = database
      .prepare(
        `SELECT * FROM transcripts WHERE text LIKE ? ORDER BY created_at DESC LIMIT ?`
      )
      .all(`%${query}%`, limit) as Row[];
    return rows.map(toTranscript);
  }
}

export function deleteTranscript(id: number): void {
  open().prepare("DELETE FROM transcripts WHERE id = ?").run(id);
}

export function clearTranscripts(): void {
  const database = open();
  database.exec("DELETE FROM transcripts");
}

export type DictationStats = { count: number; totalDurationMs: number };

export function transcriptStats(): DictationStats {
  const row = open()
    .prepare("SELECT COUNT(*) AS count, COALESCE(SUM(duration_ms), 0) AS total FROM transcripts")
    .get() as { count: number; total: number };
  return { count: row.count, totalDurationMs: row.total };
}

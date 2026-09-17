import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "fs";
import { join } from "path";
import { SESSION_CWD } from "./paths";
import { sanitizeWindowTitle } from "./windowTitle";

// Node's built-in SQLite rather than better-sqlite3 (see docs/design.md's "Dictation"):
// verified working in Electron 44's Node 24.20, including FTS5, which means
// no second native addon to rebuild against Electron's ABI on every bump —
// node-pty is already enough of that. It's still flagged experimental
// upstream, so every statement in the app goes through this one module; a
// swap to another engine is a change to this file and nothing else.
const DB_PATH = join(SESSION_CWD, "dictation.db");
const SCHEMA_VERSION = 2;

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

  if (version < 2) {
    // Titles captured before sanitizeWindowTitle existed still carry other
    // apps' emoji (Chrome's "New Tab 🔊"). Rewritten in place rather than
    // cleaned on read, so the stored history is the clean version.
    const rows = database
      .prepare("SELECT id, target_app FROM transcripts WHERE target_app IS NOT NULL")
      .all() as { id: number; target_app: string }[];
    const update = database.prepare("UPDATE transcripts SET target_app = ? WHERE id = ?");
    for (const row of rows) {
      const cleaned = sanitizeWindowTitle(row.target_app);
      if (cleaned !== row.target_app) update.run(cleaned ?? null, row.id);
    }
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

export type TranscriptFilter = {
  // Free-text search. Empty/absent means "no text filter".
  query?: string;
  // Inclusive epoch-ms bounds. Absent means unbounded on that side.
  from?: number;
  to?: number;
};

type QueryParts = { from: string; where: string; params: (string | number)[] };

/**
 * Builds the FROM/WHERE shared by listing, counting, and bulk delete, so
 * "delete everything I'm looking at" can never drift from what the list
 * actually showed — they compile to the same predicate.
 *
 * `fts` selects the text-matching strategy: FTS5 MATCH normally, or a LIKE
 * scan when MATCH would throw on the user's raw input (see queryTranscripts).
 */
function buildQuery(filter: TranscriptFilter, fts: boolean): QueryParts {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  let fromSql = "transcripts t";

  const terms = (filter.query ?? "")
    .split(/\s+/)
    .map((term) => term.replace(/"/g, ""))
    .filter((term) => term.length > 0);

  if (terms.length > 0) {
    if (fts) {
      fromSql = "transcripts t JOIN transcripts_fts f ON f.rowid = t.id";
      clauses.push("transcripts_fts MATCH ?");
      // Quoted so FTS5 treats each term as a literal — users type `-`, `"`,
      // `*` and `NEAR` constantly and those are MATCH operators. Trailing
      // `*` keeps search responsive while typing.
      params.push(terms.map((term) => `"${term}"*`).join(" "));
    } else {
      clauses.push("t.text LIKE ?");
      params.push(`%${filter.query}%`);
    }
  }

  if (typeof filter.from === "number") {
    clauses.push("t.created_at >= ?");
    params.push(filter.from);
  }
  if (typeof filter.to === "number") {
    clauses.push("t.created_at <= ?");
    params.push(filter.to);
  }

  return {
    from: fromSql,
    where: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}

// Runs `attempt` against FTS5 and falls back to a LIKE scan if MATCH
// rejects the input, so a search box can never break on punctuation — the
// same guard the previous searchTranscripts had, now shared by every
// filtered operation including delete.
function withFtsFallback<T>(filter: TranscriptFilter, attempt: (parts: QueryParts) => T): T {
  try {
    return attempt(buildQuery(filter, true));
  } catch {
    return attempt(buildQuery(filter, false));
  }
}

/** Newest-first page of transcripts matching `filter`. */
export function queryTranscripts(
  filter: TranscriptFilter = {},
  limit = 200,
  offset = 0
): Transcript[] {
  const database = open();
  return withFtsFallback(filter, ({ from, where, params }) => {
    const rows = database
      .prepare(
        `SELECT t.* FROM ${from} ${where} ORDER BY t.created_at DESC LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset) as Row[];
    return rows.map(toTranscript);
  });
}

/**
 * Deletes every transcript matching `filter` and returns how many went.
 *
 * Deliberately filter-based rather than taking a list of ids from the
 * renderer: the list is paginated, so "delete all of these" has to mean
 * everything matching the filter, not just the page in view. Sharing
 * buildQuery with queryTranscripts is what guarantees those agree.
 *
 * The AFTER DELETE trigger keeps the FTS index in sync, so removed
 * transcripts stop matching searches immediately — which matters, because
 * this is a log of things the user said out loud.
 */
export function deleteTranscripts(filter: TranscriptFilter = {}): number {
  const database = open();
  return withFtsFallback(filter, ({ from, where, params }) => {
    // Subselect rather than DELETE...JOIN: SQLite has no DELETE with a
    // join, and the FTS virtual table can only be reached through one.
    const result = database
      .prepare(`DELETE FROM transcripts WHERE id IN (SELECT t.id FROM ${from} ${where})`)
      .run(...params);
    return Number(result.changes);
  });
}

export type DictationStats = { count: number; totalDurationMs: number };

/** Count and total spoken duration for whatever `filter` selects. */
export function transcriptStats(filter: TranscriptFilter = {}): DictationStats {
  const database = open();
  return withFtsFallback(filter, ({ from, where, params }) => {
    const row = database
      .prepare(
        `SELECT COUNT(*) AS count, COALESCE(SUM(t.duration_ms), 0) AS total FROM ${from} ${where}`
      )
      .get(...params) as { count: number; total: number };
    return { count: row.count, totalDurationMs: row.total };
  });
}

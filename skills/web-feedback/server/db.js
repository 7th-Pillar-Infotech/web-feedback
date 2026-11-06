'use strict';

/**
 * Shared SQLite access for the web-feedback collector.
 * Used by both feedback-server.js (HTTP) and feedback-cli.js (Claude's CLI).
 *
 * The DB file and screenshot directory can be relocated with env vars so a
 * project can keep feedback local to itself instead of the global default:
 *   FEEDBACK_DB   absolute path to the .db file   (default: ./feedback.db)
 *   FEEDBACK_DIR  directory for saved screenshots (default: ./screenshots)
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.FEEDBACK_DB
  ? path.resolve(process.env.FEEDBACK_DB)
  : path.join(__dirname, 'feedback.db');

const SHOTS_DIR = process.env.FEEDBACK_DIR
  ? path.resolve(process.env.FEEDBACK_DIR)
  : path.join(__dirname, 'screenshots');

fs.mkdirSync(SHOTS_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS feedback (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    number         INTEGER NOT NULL,          -- per-project sequential feedback count
    project        TEXT    NOT NULL,          -- host or explicit project name
    url            TEXT    NOT NULL,          -- full page URL the feedback was left on
    text           TEXT    NOT NULL,          -- the user's feedback message
    selector       TEXT,                      -- CSS selector of the clicked element
    element_text   TEXT,                      -- trimmed text content of that element
    page_x         REAL,                      -- click X in page coordinates
    page_y         REAL,                      -- click Y in page coordinates
    viewport_x     REAL,                      -- click X in viewport coordinates
    viewport_y     REAL,                      -- click Y in viewport coordinates
    viewport_w     INTEGER,
    viewport_h     INTEGER,
    screenshot     TEXT,                      -- relative path of the annotated PNG
    status         TEXT    NOT NULL DEFAULT 'open',   -- 'open' | 'resolved'
    created_at     TEXT    NOT NULL,
    resolved_at    TEXT,
    resolution_note TEXT
  );
`);

// --- lightweight migrations -------------------------------------------------
// Add columns introduced after the first release. SQLite has no
// "ADD COLUMN IF NOT EXISTS", so we check the current schema first. Each of
// these is a nullable TEXT column, so adding it to an existing DB is safe.
const existingCols = new Set(db.prepare('PRAGMA table_info(feedback)').all().map((c) => c.name));
const LATER_COLUMNS = {
  capture_error: 'TEXT', // why the screenshot failed (null when it succeeded)
  console_logs: 'TEXT',  // JSON array of recent console entries at submit time
  network_logs: 'TEXT',  // JSON array of recent network requests at submit time
};
for (const [name, type] of Object.entries(LATER_COLUMNS)) {
  if (!existingCols.has(name)) db.exec(`ALTER TABLE feedback ADD COLUMN ${name} ${type}`);
}

function nextNumber(project) {
  const row = db
    .prepare('SELECT COALESCE(MAX(number), 0) AS n FROM feedback WHERE project = ?')
    .get(project);
  return row.n + 1;
}

module.exports = { db, DB_PATH, SHOTS_DIR, nextNumber };

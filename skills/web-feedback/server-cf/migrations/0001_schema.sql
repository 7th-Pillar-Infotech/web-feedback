-- web-feedback collector schema (D1).
-- Mirrors server/db.js so rows are interchangeable between the Node collector
-- and the Worker, plus screenshot_data for the no-R2 fallback.
CREATE TABLE IF NOT EXISTS feedback (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  number          INTEGER NOT NULL,            -- per-project sequential feedback count
  project         TEXT    NOT NULL,            -- host or explicit project name
  url             TEXT    NOT NULL,            -- full page URL the feedback was left on
  text            TEXT    NOT NULL,            -- the user's feedback message
  selector        TEXT,                        -- CSS selector of the clicked element
  element_text    TEXT,                        -- trimmed text content of that element
  page_x          REAL,                        -- click X in page coordinates
  page_y          REAL,                        -- click Y in page coordinates
  viewport_x      REAL,
  viewport_y      REAL,
  viewport_w      INTEGER,
  viewport_h      INTEGER,
  screenshot      TEXT,                        -- relative path/key of the annotated PNG
  screenshot_data TEXT,                        -- base64 PNG when no R2 bucket is bound
  capture_error   TEXT,                        -- why the screenshot failed (null on success)
  console_logs    TEXT,                        -- JSON array of recent console entries
  network_logs    TEXT,                        -- JSON array of recent network requests
  status          TEXT    NOT NULL DEFAULT 'open',   -- 'open' | 'resolved'
  created_at      TEXT    NOT NULL,
  resolved_at     TEXT,
  resolution_note TEXT
);

CREATE INDEX IF NOT EXISTS idx_feedback_project_status ON feedback (project, status);
CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback (created_at DESC);

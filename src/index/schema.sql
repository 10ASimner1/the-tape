-- The index is a DERIVED artifact. Everything here is reconstructable from
-- raw/obs and raw/osv, so it can be deleted and rebuilt at any time — that is the
-- property the whole archive design exists to preserve.
--
-- Deliberately absent: any column that could hold an email address. The recorder
-- never writes one, and a schema that cannot express it is one fewer way for that
-- to stop being true. Maintainers appear as npm logins (public handles) and as
-- salted hashes, never as contact details.

PRAGMA journal_mode = OFF;
PRAGMA synchronous = OFF;

CREATE TABLE IF NOT EXISTS packages (
  name             TEXT PRIMARY KEY,
  first_seen       TEXT NOT NULL,
  last_seen        TEXT NOT NULL,
  created          INTEGER,
  latest_version   TEXT,
  version_count    INTEGER,
  observations     INTEGER NOT NULL DEFAULT 0,
  is_dead          INTEGER NOT NULL DEFAULT 0,
  unpublished_at   INTEGER,
  security_holder  TEXT,
  maintainers      TEXT,
  flags            TEXT
);

-- A compact summary per observation. The full row lives in raw/obs; this exists
-- so the index can answer "when did we look, and what did we see" without
-- duplicating the archive.
CREATE TABLE IF NOT EXISTS observations (
  name          TEXT NOT NULL,
  run_id        TEXT NOT NULL,
  seq           INTEGER,
  rev           TEXT,
  rev_int       INTEGER,
  fetched_at    TEXT NOT NULL,
  status        INTEGER,
  outcome       TEXT,
  version_count INTEGER,
  truncated     INTEGER,
  -- True totals before the row's lists were capped. A churning package's real
  -- yank count is unrecoverable without these.
  missing_count INTEGER,
  recent_count  INTEGER,
  PRIMARY KEY (name, run_id)
);

-- Event ids are canonical, so re-deriving over the same observations collides on
-- the primary key and INSERT OR IGNORE makes rebuilds idempotent for free.
CREATE TABLE IF NOT EXISTS events (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  name        TEXT NOT NULL,
  version     TEXT,
  at          INTEGER NOT NULL,
  observed_at TEXT NOT NULL,
  run_id      TEXT,
  seq         INTEGER,
  -- 1 when inferred from a package's first sighting: history, not news.
  backfill    INTEGER NOT NULL DEFAULT 0,
  detail      TEXT
);

CREATE TABLE IF NOT EXISTS osv_records (
  id           TEXT PRIMARY KEY,
  modified     TEXT,
  published    TEXT,
  summary      TEXT,
  is_malicious INTEGER NOT NULL DEFAULT 0,
  raw          TEXT
);

-- version IS NULL means "this package, any version" — necessary because ~11% of
-- recently-malicious packages already 404, so there is often no version list to
-- join against.
CREATE TABLE IF NOT EXISTS osv_affects (
  osv_id  TEXT NOT NULL,
  name    TEXT NOT NULL,
  version TEXT,
  -- explicit | range | unknown. A NULL version with basis='range' means the record
  -- described ranges we did not enumerate — NOT that every version is affected.
  basis   TEXT NOT NULL DEFAULT 'unknown',
  PRIMARY KEY (osv_id, name, version)
);

CREATE TABLE IF NOT EXISTS typosquat (
  name    TEXT PRIMARY KEY,
  score   REAL NOT NULL,
  nearest TEXT
);

-- Everything that did not go to plan. Without these a reader cannot distinguish
-- "nothing happened" from "we failed and gave up", which for an evidentiary
-- archive is the difference between a record and a rumour.
CREATE TABLE IF NOT EXISTS gaps (
  run_id TEXT,
  kind   TEXT,
  name   TEXT,
  seq    INTEGER,
  status INTEGER,
  detail TEXT,
  at     TEXT
);

CREATE TABLE IF NOT EXISTS build_meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE INDEX IF NOT EXISTS events_name       ON events (name);
CREATE INDEX IF NOT EXISTS events_kind_at    ON events (kind, at);
CREATE INDEX IF NOT EXISTS events_at         ON events (at);
CREATE INDEX IF NOT EXISTS obs_name          ON observations (name);
CREATE INDEX IF NOT EXISTS osv_affects_name  ON osv_affects (name);
CREATE INDEX IF NOT EXISTS packages_dead     ON packages (is_dead, unpublished_at);

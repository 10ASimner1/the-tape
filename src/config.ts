/**
 * Every tunable in the project lives here. No magic numbers anywhere else.
 *
 * Numbers marked MEASURED were established against the live APIs on 2026-08-02
 * (see docs/assumptions.md). Do not change them without re-measuring.
 */

export const VERSION = '0.1.0';

/** Repo URL and contact go in the User-Agent: npm reserves the right to ban by user-agent,
 *  and a contactable UA is the difference between an email and a ban. */
export const REPO_URL = process.env['TAPE_REPO_URL'] ?? 'https://github.com/unset/the-tape';
export const CONTACT = process.env['TAPE_CONTACT'] ?? '';
export const USER_AGENT =
  `the-tape/${VERSION} (+${REPO_URL}${CONTACT ? `; contact: ${CONTACT}` : ''})`;

// ── Endpoints ────────────────────────────────────────────────────────────────
// The documented post-Feb-2025 replication path. The bare /_changes also works
// today but is undocumented, so we use /registry/_changes.
export const FEED_URL = 'https://replicate.npmjs.com/registry/_changes';
export const FEED_ROOT_URL = 'https://replicate.npmjs.com/';
export const REGISTRY_URL = 'https://registry.npmjs.org';
export const OSV_MODIFIED_CSV =
  'https://storage.googleapis.com/osv-vulnerabilities/npm/modified_id.csv';
export const OSV_RECORD_URL = 'https://storage.googleapis.com/osv-vulnerabilities/npm';

// ── Feed ─────────────────────────────────────────────────────────────────────
/** MEASURED: limit=10000 → 200, limit=10001 → 400. Hard cap, not a suggestion. */
export const FEED_PAGE_LIMIT = 10_000;
/** MEASURED: seq is sparse at ~3-6 units per emitted row. Outside this band, something
 *  changed upstream and the run logs a feed anomaly (it does not fail — the rows are
 *  still real, we just want to know). */
export const FEED_SEQ_PER_ROW_MIN = 1.5;
export const FEED_SEQ_PER_ROW_MAX = 12;

// ── Politeness ───────────────────────────────────────────────────────────────
// npm's crawler policy asks ~1 req/s and its acceptable-use post allows ~5M
// requests/month. Steady state here is ~626k/month (12.5% of that ceiling).
export const REGISTRY_RPS_STEADY = 1.5;
export const REGISTRY_CONCURRENCY_STEADY = 2;
/** Backlog mode: ~3.24M/month if sustained, still under npm's stated ceiling. */
export const REGISTRY_RPS_BACKLOG = 5;
export const REGISTRY_CONCURRENCY_BACKLOG = 5;
/** A run is in backlog mode when the fetch queue exceeds this. */
export const BACKLOG_THRESHOLD = 3_000;
/** Anti-wedge: past this, the run captures the feed and skips fetching entirely.
 *  Enrichment must never starve capture. */
export const TRIAGE_THRESHOLD = 50_000;

export const HTTP_TIMEOUT_MS = 30_000;
export const HTTP_MAX_RETRIES = 4;
/** MEASURED: largest real packument seen was 4.88 MB gzipped / 26.8 MB raw.
 *  A response past this is aborted mid-stream and recorded as a gap. */
export const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

// ── Run budget ───────────────────────────────────────────────────────────────
// Deadline-driven, never clock-driven: GitHub documents that scheduled runs are
// delayed or dropped, worst at the top of the hour.
export const FETCH_CUT_MS = 38 * 60_000;
export const HARD_DEADLINE_MS = 45 * 60_000;

// ── Observation row shape ────────────────────────────────────────────────────
/** Versions published within this window carry full detail on the row. Older ones
 *  carry only [version, epoch] — enough to derive the event, without the payload. */
export const RECENT_LOOKBACK_MS = 30 * 24 * 60 * 60_000;

/**
 * The [version, epoch] list is bounded two ways, because the first live run found
 * both bounds mattering on real packages.
 *
 * TIMES_WINDOW_MS is the primary bound and it is a FIXED lookback from the moment
 * of observation, never a watermark that advances with runs. That distinction is
 * the whole reason this design is safe: a packument fetched seven hours late still
 * gets the same 90 days of history, so a fetch backlog cannot outrun it. A package
 * only appears in the feed when it publishes, so it is always observed within hours
 * of a change — 90 days of slack is enormous, and `versionCount` + `versionsDigest`
 * detect the pathological case anyway.
 *
 * The caps are hard ceilings for packages that defeat the window. MEASURED on the
 * first live run: @atlassian-test-prod/synth-check carries 22,603 versions of which
 * 17,114 are unpublished, and @agentconnect.md/daemon published 537 versions inside
 * 30 days. Uncapped, those produced 453 KB and 245 KB rows against a design budget
 * of ~1 KB. Truncation sets the `truncated` flag and the true totals are always
 * kept alongside, so nothing is silently lost.
 */
export const TIMES_WINDOW_MS = 7 * 24 * 60 * 60_000;
export const TIMES_CAP = 100;
export const MISSING_CAP = 100;
export const RECENT_CAP = 20;

/**
 * "Brand new" means created in the last 48 hours, not the last 30 days.
 *
 * This was 30 days on the first live run and it was the single biggest cost error
 * in the project: it made 30% of changed packages qualify as new (against a
 * measured 16.7%), and worse, the ones it wrongly caught were established churning
 * packages whose packuments average 44 KB rather than the 3.4 KB a genuinely new
 * package costs. 48h is double the measurement window, so a backlog still lands
 * inside it.
 */
export const NEW_PACKAGE_WINDOW_MS = 48 * 60 * 60_000;

/** No single packument may dominate a run's storage. Above this it is skipped and
 *  a gap row records the decision, so the omission is queryable rather than silent. */
export const MAX_RETAINED_PACKUMENT_BYTES = 512 * 1024;

// ── Storage ──────────────────────────────────────────────────────────────────
export const SHARD_MAX_ROWS = 250;
export const SHARD_MAX_BYTES = 4 * 1024 * 1024;
// A self-imposed spend cap belongs here (object stores bill overage rather than
// hard-stopping), but it is NOT implemented yet — see Phase 2. The constants that
// used to sit here were never read by anything, which made the README's claim that
// "the recorder stops itself" false. Measured growth crosses the free tier around
// day 400, so this is scheduled work, not an emergency.

// ── The second copy ──────────────────────────────────────────────────────────
/**
 * What the mirror copies, and THE ORDER IS THE PRIORITY.
 *
 * A mirror run that runs out of time has copied the irreplaceable things first.
 * That is rule 1 expressed as a constant rather than as a hope.
 *
 * Every prefix here is IMMUTABLE, and that is what makes the whole design cheap:
 * the mirror is a pure append, so the mirror credential needs neither delete nor
 * overwrite, and a diff of two listings is a complete and correct description of
 * what is missing. Notably absent:
 *
 *   state/cursor.json  Mutable. Mirroring it would force a put-vs-putIfAbsent
 *                      choice that is wrong either way, and it is unnecessary —
 *                      recoverFromArchive() re-derives lastSeq exactly from the
 *                      feed object keys. Leaving it out means the restore drill
 *                      exercises that recovery path every single time, which is
 *                      the path you actually want proven.
 *   work/              Explicitly a cache, not a record (see store.ts).
 *   state/selfcheck/   Litter from the pre-run probe.
 *
 * Deliberately NOT a watermark. private/pkg/<name>/<rev> keys carry no date, so a
 * new key can appear anywhere in the keyspace at any time, and private/ is the
 * large majority of the object count — a lexical high-water mark there would skip
 * writes silently. It is the same trap cursor.ts refuses for the same reason.
 * Listing is free on B2 (Class B/C), so there is nothing to buy by being clever.
 */
export const MIRROR_PREFIXES = [
  'raw/feed/', // THE irreplaceable file — nothing else on the internet has it
  'raw/runs/', // manifests: what the git ledger is checked against
  'raw/obs/', //  the index is rebuilt from these
  'raw/osv/',
  'private/', // discretionary: re-fetchable while the package still exists
] as const;

/** A fixed key on each side. Written to the mirror and read back from the
 *  primary: if it comes back, the two "independent" stores are one bucket. */
export const MIRROR_PROBE_KEY = 'mirror/probe.json';
export const MIRROR_STATE_KEY = 'mirror/state.json';

export const SECURITY_HOLDER_REPO = 'git+https://github.com/npm/security-holder.git';
export const NPM_HOLDER_LOGIN = 'npm';
export const NPM_HOLDER_EMAIL = 'npm@npmjs.com';

/**
 * Every rule the assumptions pass measured, as pure functions over a packument.
 * Zero I/O. Every unit test points at exactly this file.
 *
 * The central insight of the whole recorder lives here: THE PACKUMENT IS THE STATE.
 * npm's `time` map is its own server-side log of every version that ever existed,
 * with a timestamp the publisher cannot forge. So the recorder needs no durable
 * per-package state — one fetch recovers everything, including the full unpublish
 * history of a package we are seeing for the first time.
 *
 * These functions never return an email address. `isSecurityHolder` reads one to
 * produce a boolean and discards it; that is the only place on the archive path
 * where an address is read at all.
 */

import {
  MISSING_CAP,
  NEW_PACKAGE_WINDOW_MS,
  NPM_HOLDER_EMAIL,
  NPM_HOLDER_LOGIN,
  RECENT_CAP,
  RECENT_LOOKBACK_MS,
  SECURITY_HOLDER_REPO,
  TIMES_CAP,
  TIMES_WINDOW_MS,
} from './config.ts';
import { hashEmail } from './pii.ts';

// ── Safe accessors over third-party JSON ─────────────────────────────────────
// A packument is whatever the registry sends. Nothing here assumes a shape.

type Dict = Record<string, unknown>;

function asDict(v: unknown): Dict | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Dict) : null;
}
function asStr(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function asArr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
/** ISO-8601 → epoch seconds. Null on anything unparseable. */
function epoch(v: unknown): number | null {
  const s = asStr(v);
  if (s === null) return null;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/** `time` is a FLAT map mixing three reserved keys with one key per version.
 *  Any parser must exclude these before treating keys as semver. */
const RESERVED_TIME_KEYS = new Set(['created', 'modified', 'unpublished']);

export type VersionTime = readonly [version: string, epochSeconds: number];

// ── Core reads ───────────────────────────────────────────────────────────────

export function name(doc: Dict): string | null {
  return asStr(doc['name']) ?? asStr(doc['_id']);
}

export function rev(doc: Dict): string | null {
  return asStr(doc['_rev']);
}

/** The integer prefix of a rev is a per-document mutation counter. A jump of >1
 *  between consecutive observations proves mutations we could not explain — the
 *  only trace that exists of an unpublish-then-republish inside one interval. */
export function revInt(doc: Dict): number | null {
  const r = rev(doc);
  if (r === null) return null;
  const m = /^(\d+)-/.exec(r);
  return m?.[1] !== undefined ? Number(m[1]) : null;
}

export function created(doc: Dict): number | null {
  return epoch(asDict(doc['time'])?.['created']);
}

export function modified(doc: Dict): number | null {
  return epoch(asDict(doc['time'])?.['modified']);
}

export function distTags(doc: Dict): Record<string, string> {
  const tags = asDict(doc['dist-tags']);
  const out: Record<string, string> = {};
  if (tags) for (const [k, v] of Object.entries(tags)) {
    const s = asStr(v);
    if (s !== null) out[k] = s;
  }
  return out;
}

export function latestVersion(doc: Dict): string | null {
  return distTags(doc)['latest'] ?? null;
}

/** npm usernames only. Public, pseudonymous handles — safe for the public tier. */
export function maintainerLogins(doc: Dict): string[] {
  const out: string[] = [];
  for (const m of asArr(doc['maintainers'])) {
    const n = asStr(asDict(m)?.['name']);
    if (n !== null) out.push(n);
  }
  return out.sort();
}

/** Salted pseudonyms, so a maintainer email CHANGE is still detectable across
 *  observations without the address ever being stored. */
export function maintainerEmailHashes(doc: Dict): string[] {
  const out: string[] = [];
  for (const m of asArr(doc['maintainers'])) {
    const e = asStr(asDict(m)?.['email']);
    if (e !== null) out.push(hashEmail(e));
  }
  return out.sort();
}

// ── The `time` map ───────────────────────────────────────────────────────────

/** Every version key in `time`, with its publish instant. This is the recovery of
 *  the ~46% of version events the changes feed coalesces away: the feed shows one
 *  row, the time map shows all of them. */
export function allVersionTimes(doc: Dict): VersionTime[] {
  const time = asDict(doc['time']);
  if (!time) return [];
  const out: VersionTime[] = [];
  for (const [k, v] of Object.entries(time)) {
    if (RESERVED_TIME_KEYS.has(k)) continue;
    const t = epoch(v);
    if (t !== null) out.push([k, t]);
  }
  out.sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1));
  return out;
}

/** Keeps the newest `cap` entries. Ordering is oldest-first, so this is a tail. */
function newest(entries: VersionTime[], cap: number): VersionTime[] {
  return entries.length <= cap ? entries : entries.slice(entries.length - cap);
}

/**
 * What actually goes on the row: versions published inside the fixed window, then
 * a hard ceiling. A react-sized packument (2,896 versions) collapses to a handful,
 * because only recent entries can be new to us.
 */
export function cappedVersionTimes(doc: Dict, nowMs: number): VersionTime[] {
  const cutoff = Math.floor((nowMs - TIMES_WINDOW_MS) / 1000);
  const all = allVersionTimes(doc);
  const windowed = all.filter(([, t]) => t >= cutoff);
  return newest(windowed, TIMES_CAP);
}

/** Truncate the yank list the same way, newest first, so a churning test package
 *  cannot dominate a day's archive. The count is preserved by the caller. */
export function cappedMissingVersions(doc: Dict): VersionTime[] {
  return newest(missingVersions(doc), MISSING_CAP);
}

// ── Unpublish detection ──────────────────────────────────────────────────────

/**
 * A fully unpublished package returns HTTP 200 with a TOMBSTONE, not a 404.
 * Measured: 50/50 sampled deleted ids returned 200. The body has no `versions`
 * and no `dist-tags` at all.
 */
export function isTombstone(doc: Dict): boolean {
  const time = asDict(doc['time']);
  if (time !== null && 'unpublished' in time) return true;
  return !('versions' in doc);
}

export type UnpublishInfo = {
  /** ALWAYS from time.unpublished.time. `time.modified` is NOT the unpublish
   *  time — nethix reads modified 2026-08-01 but unpublished 2022-03-11. */
  readonly at: number;
  /** The npm username of whoever ran `npm unpublish`. Present only on the legacy
   *  5-key shape. Note this is a USERNAME, not the package name. */
  readonly by: string | null;
  /** Lexicographically sorted by npm, and may be a SUBSET of the versions the
   *  package ever had — never trust it as the version list. */
  readonly versions: string[];
};

/**
 * Two incompatible shapes are live right now: a modern 2-key `{time, versions}`
 * and a legacy 5-key `{name, time, tags, versions, maintainers}`. 29 of 40
 * historical samples were legacy, so a type requiring all five crashes on ~28%
 * of tombstones. Reading only `.time` and `.name` parses both identically.
 */
export function unpublishInfo(doc: Dict): UnpublishInfo | null {
  const u = asDict(asDict(doc['time'])?.['unpublished']);
  if (!u) return null;
  const at = epoch(u['time']);
  if (at === null) return null;
  const versions: string[] = [];
  for (const v of asArr(u['versions'])) {
    const s = asStr(v);
    if (s !== null) versions.push(s);
  }
  return { at, by: asStr(u['name']), versions };
}

/**
 * PER-VERSION UNPUBLISH — the case the project exists for, and the one the spec
 * missed entirely. It sets NO `time.unpublished`. The only signal is that the
 * version key survives in `time` but is gone from `versions`.
 *
 * Verified against every historically-compromised package with zero false
 * positives on clean controls:
 *   chalk 5.6.1 · debug 4.4.2 · event-stream 3.3.6 · ua-parser-js 0.7.29/0.8.0/1.0.0
 *   coa (6 versions) · rc (3) · @ctrl/tinycolor 4.1.1/4.1.2
 *   left-pad / lodash / compresion → []
 *
 * Computable from a SINGLE fetch, so first contact with a package recovers its
 * entire unpublish history — no prior snapshot, no backfill job.
 *
 * Returns [] for a tombstone: a fully unpublished package has an empty `versions`
 * map, so every version would otherwise report as missing. That is one
 * `package_unpublish`, not N `version_unpublish` events.
 */
export function missingVersions(doc: Dict): VersionTime[] {
  if (isTombstone(doc)) return [];
  const versions = asDict(doc['versions']);
  if (!versions) return [];
  return allVersionTimes(doc).filter(([v]) => !(v in versions));
}

// ── Security holding packages ────────────────────────────────────────────────

export type HolderConfidence = 'confirmed' | 'suspected' | null;

/**
 * There is NO machine-readable marker, and every single-signal rule has real
 * false positives:
 *   - description "security holding package" is imitated verbatim by Yandex,
 *     Epic Games and Haufe-Lexware on packages npm never touched
 *   - maintainers == npm covers 1,624 packages, including takeovers like
 *     `compresion` that keep entirely normal content
 *   - even the version name is forgeable: crossenv@0.0.1-security was published
 *     by the ATTACKER from npm's own security-holder template
 *
 * So: require a conjunction, and record a confidence rather than a boolean.
 * Description text is never used as a signal.
 */
export function securityHolder(doc: Dict): HolderConfidence {
  const latest = latestVersion(doc);
  if (latest === null || !/-security$/.test(latest)) return null;

  const versions = asDict(doc['versions']);
  const repoUrl = asStr(asDict(asDict(versions?.[latest])?.['repository'])?.['url']);
  const repoMatches = repoUrl === SECURITY_HOLDER_REPO;

  // Reads an address to produce a boolean, then discards it. The only place on
  // the archive path where an email is read.
  let npmMaintains = false;
  for (const m of asArr(doc['maintainers'])) {
    const d = asDict(m);
    if (asStr(d?.['name']) === NPM_HOLDER_LOGIN && asStr(d?.['email']) === NPM_HOLDER_EMAIL) {
      npmMaintains = true;
      break;
    }
  }

  if (repoMatches && npmMaintains) return 'confirmed';
  if (repoMatches || npmMaintains) return 'suspected';
  return null;
}

// ── Per-version detail ───────────────────────────────────────────────────────

/** The classic malware vector. The FULL packument has no `hasInstallScript` (that
 *  is abbreviated-only), so the scripts block must be inspected directly. */
export function installScripts(versionDoc: Dict): string[] {
  const scripts = asDict(versionDoc['scripts']);
  if (!scripts) return [];
  return ['preinstall', 'install', 'postinstall'].filter((k) => asStr(scripts[k]) !== null);
}

export type VersionDetail = {
  readonly v: string;
  readonly t: number;
  readonly by: string | null;
  readonly installScripts: string[];
  readonly deps: number;
  readonly integrity: string | null;
  readonly shasum: string | null;
  // No `tarball`: it is a deterministic function of name and version, and at
  // ~80 bytes on every version detail it was pure overhead.
  readonly unpackedSize: number | null;
  readonly fileCount: number | null;
  readonly license: string | null;
  readonly repoHost: string | null;
  /** The deprecation MESSAGE, not a boolean — the text is the interesting part. */
  readonly deprecated: string | null;
};

/** Hostname only, never the raw URL: a repository field is attacker-controlled
 *  free text and could carry anything, including an address. */
function repoHost(versionDoc: Dict): string | null {
  const url = asStr(asDict(versionDoc['repository'])?.['url']);
  if (url === null) return null;
  try {
    return new URL(url.replace(/^git\+/, '').replace(/^git:/, 'https:')).hostname || null;
  } catch {
    return null;
  }
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Full detail for versions published inside the lookback window. Older versions
 * still appear in the row's [version, epoch] list — enough to derive the event —
 * they just do not carry the payload.
 *
 * This lookback is fixed and generous, NOT a moving watermark. That distinction
 * matters: a watermark that advances while a fetch backlog drains silently drops
 * every event behind it. Falling outside a fixed window costs detail, never an event.
 *
 * Capped at the newest RECENT_CAP entries: @agentconnect.md/daemon published 537
 * versions inside 30 days on the first live run, producing a 245 KB row.
 */
export function recentVersionDetails(doc: Dict, nowMs: number): VersionDetail[] {
  const versions = asDict(doc['versions']);
  if (!versions) return [];

  // Eligibility is decided BEFORE the cap. Capping first would silently shrink the
  // list on any package with yanked versions, because those carry no detail —
  // exactly the packages we care most about.
  const out: VersionDetail[] = [];
  for (const [v, t] of newest(detailEligible(doc, nowMs), RECENT_CAP)) {
    const vd = asDict(versions[v]);
    if (!vd) continue; // unpublished — reported via missingVersions instead
    const dist = asDict(vd['dist']);
    const deprecated = asStr(vd['deprecated']);
    out.push({
      v,
      t,
      by: asStr(asDict(vd['_npmUser'])?.['name']),
      installScripts: installScripts(vd),
      deps: Object.keys(asDict(vd['dependencies']) ?? {}).length,
      integrity: asStr(dist?.['integrity']),
      shasum: asStr(dist?.['shasum']),
      unpackedSize: num(dist?.['unpackedSize']),
      fileCount: num(dist?.['fileCount']),
      license: asStr(vd['license']),
      repoHost: repoHost(vd),
      deprecated,
    });
  }
  return out;
}

/**
 * Versions eligible for full detail: published in [now - 30d, now].
 *
 * The upper bound matters even though a real observation is always at or after
 * the publish instant — it makes the window a closed interval, so the index can
 * re-derive detail for any historical point and get the same answer the recorder
 * got at the time. A small forward tolerance absorbs clock skew rather than
 * discarding a legitimately fresh version.
 *
 * Note `times` deliberately has NO upper bound: it is what events are derived
 * from, and dropping a future-dated entry there could lose an event outright.
 * Here the cost of exclusion is only missing detail.
 */
const CLOCK_SKEW_TOLERANCE_S = 3600;

function detailEligible(doc: Dict, nowMs: number): VersionTime[] {
  const versions = asDict(doc['versions']);
  if (!versions) return [];
  const nowSec = Math.floor(nowMs / 1000);
  const cutoff = nowSec - RECENT_LOOKBACK_MS / 1000;
  return allVersionTimes(doc).filter(
    ([v, t]) => t >= cutoff && t <= nowSec + CLOCK_SKEW_TOLERANCE_S && v in versions,
  );
}

/** How many versions fall inside the detail window before the cap is applied. */
export function recentVersionCount(doc: Dict, nowMs: number): number {
  return detailEligible(doc, nowMs).length;
}

/** A package that came into existence in the last 48 hours. Its full packument is
 *  the origin record and costs ~3.4 KB gzipped, because it has exactly one version. */
export function isNewPackage(doc: Dict, nowMs: number): boolean {
  const c = created(doc);
  return c !== null && c * 1000 >= nowMs - NEW_PACKAGE_WINDOW_MS;
}

export type { Dict as PackumentDoc };

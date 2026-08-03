/**
 * The observation row — the unit the archive is made of, and the reason the
 * index is genuinely rebuildable from raw.
 *
 * The row is ABSOLUTE, never relative: it records what the packument said, not a
 * diff against something the recorder remembered. That one property is what makes
 * backlogs, deferrals and retries harmless — a packument fetched seven hours late
 * still carries its complete `time` map, so the index's diff against the previous
 * observation is exact no matter when the fetch landed.
 *
 * It is also a complete EXTRACT rather than a pointer. Full packuments are kept
 * for only ~18% of changes (new and flagged packages), so any field missing from
 * this row is unrecoverable for the other 82%.
 */

import { createHash } from 'node:crypto';

import * as pk from './packument.ts';
import type { PackumentDoc, VersionDetail, VersionTime } from './packument.ts';
import type { FeedRow } from './feed.ts';
import type { FetchOutcome, PackumentResult } from './registry.ts';

export type Observation = {
  readonly k: 'obs';
  readonly schema: 1;
  readonly run: string;
  readonly name: string;
  readonly seq: number;
  /** From the feed row — known before a single registry request is spent. */
  readonly rev: string | null;
  readonly revInt: number | null;
  /** True when the feed flagged this change as a deletion. Only ever a HINT to
   *  fetch: the feed re-emits ancient tombstones (nethix surfaced in 2026 having
   *  died in 2022) and can repeat the same package across windows. The registry
   *  document decides what actually happened, and when. */
  readonly feedDeleted: boolean;
  readonly fetchedAt: string;
  readonly status: number;
  readonly outcome: FetchOutcome;
  readonly bytes: number;

  readonly created: number | null;
  readonly modified: number | null;
  readonly distTags: Record<string, string>;
  readonly maintainers: string[];
  /** Salted pseudonyms. A CHANGE here between observations is the
   *  account-takeover signal; the address itself is never stored. */
  readonly maintainerHashes: string[];

  readonly versionCount: number;
  readonly versionsDigest: string | null;
  /** [version, epochSeconds] for the most recent versions. The index derives
   *  publish events by diffing this against the previous observation. */
  readonly times: VersionTime[];
  /** Per-version unpublishes, ALWAYS with the version's original publish time. */
  readonly missing: VersionTime[];
  /** Full detail for versions inside the fixed lookback window. */
  readonly recent: VersionDetail[];
  /** True totals before truncation. A churning package must not be able to
   *  understate itself just because its row was capped, so the counts always
   *  survive even when the lists do not. */
  readonly missingCount: number;
  readonly recentCount: number;
  readonly truncated: boolean;

  readonly tombstone: boolean;
  readonly unpublishedAt: number | null;
  readonly unpublishedBy: string | null;
  readonly unpublishedVersions: string[];
  readonly securityHolder: pk.HolderConfidence;
  readonly isNew: boolean;
  readonly installScriptVersions: string[];
  /** Set when the full packument was retained. */
  readonly packumentKey: string | null;
  readonly flags: string[];
};

/** A first-class row for everything that did NOT go to plan.
 *  Without these, a reader six months from now cannot tell "nothing happened to
 *  package X" from "we failed to fetch X three times and gave up" — which for an
 *  evidentiary archive is the difference between a record and a rumour. */
export type Gap = {
  readonly k: 'gap';
  readonly schema: 1;
  readonly run: string;
  readonly kind:
    | 'fetch_failed'
    | 'too_large'
    | 'deferred'
    | 'triage'
    | 'budget_stop'
    /** The PII gate refused this package's bytes. Recorded and skipped rather
     *  than aborting: the tape outranks any single package. */
    | 'pii_refused'
    /** Reconstructed from raw/feed after a run died before finishing. */
    | 'recovered';
  readonly name: string | null;
  readonly seq: number | null;
  readonly rev: string | null;
  readonly status: number | null;
  readonly detail: string | null;
  readonly at: string;
};

export type Row = Observation | Gap;

function versionsDigest(doc: PackumentDoc): string | null {
  const versions = doc['versions'];
  if (typeof versions !== 'object' || versions === null) return null;
  const sorted = Object.keys(versions as Record<string, unknown>).sort();
  return `sha256:${createHash('sha256').update(sorted.join('\n')).digest('hex').slice(0, 32)}`;
}

export type BuildInput = {
  readonly runId: string;
  readonly row: FeedRow;
  readonly result: PackumentResult;
  readonly now: Date;
  readonly packumentKey: string | null;
};

export function buildObservation(input: BuildInput): Observation {
  const { runId, row, result, now, packumentKey } = input;
  const doc = result.doc;
  const rev = row.changes[0]?.rev ?? null;

  const base = {
    k: 'obs' as const,
    schema: 1 as const,
    run: runId,
    name: row.id,
    seq: row.seq,
    rev,
    revInt: rev !== null ? pk.revInt({ _rev: rev }) : null,
    feedDeleted: row.deleted === true,
    fetchedAt: now.toISOString(),
    status: result.status,
    outcome: result.outcome,
    bytes: result.bytes,
  };

  if (doc === null) {
    // 404, too-large or a transient error. The event survives even though the
    // detail does not — which for a package npm has already purged is the whole point.
    return {
      ...base,
      created: null, modified: null, distTags: {}, maintainers: [], maintainerHashes: [],
      versionCount: 0, versionsDigest: null, times: [], missing: [], recent: [],
      missingCount: 0, recentCount: 0, truncated: false,
      tombstone: false, unpublishedAt: null, unpublishedBy: null, unpublishedVersions: [],
      securityHolder: null, isNew: false, installScriptVersions: [], packumentKey: null,
      flags: result.outcome === 'gone' ? ['gone'] : ['fetch_failed'],
    };
  }

  const unpublish = pk.unpublishInfo(doc);
  const missingCount = pk.missingVersions(doc).length;
  const missing = pk.cappedMissingVersions(doc);
  const recentAll = pk.recentVersionCount(doc, now.getTime());
  const recent = pk.recentVersionDetails(doc, now.getTime());
  const truncated = missing.length < missingCount || recent.length < recentAll;
  const tombstone = pk.isTombstone(doc);
  const holder = pk.securityHolder(doc);
  const isNew = pk.isNewPackage(doc, now.getTime());
  const installScriptVersions = recent.filter((d) => d.installScripts.length > 0).map((d) => d.v);

  const flags: string[] = [];
  if (isNew) flags.push('new_package');
  if (installScriptVersions.length > 0) flags.push('install_scripts');
  if (missingCount > 0) flags.push('version_unpublished');
  if (tombstone) flags.push('package_unpublished');
  if (holder !== null) flags.push(`security_holder_${holder}`);
  // States the mechanical fact only — this row was capped — rather than claiming
  // "high churn", which fired on ~31% of a live sample and would be a diluted
  // signal. What counts as churn is a threshold question, and thresholds belong
  // in the index where they can be re-derived across all history from
  // `recentCount` and `missingCount`.
  if (truncated) flags.push('truncated');

  return {
    ...base,
    created: pk.created(doc),
    modified: pk.modified(doc),
    distTags: pk.distTags(doc),
    maintainers: pk.maintainerLogins(doc),
    maintainerHashes: pk.maintainerEmailHashes(doc),
    versionCount: pk.allVersionTimes(doc).length,
    versionsDigest: versionsDigest(doc),
    times: pk.cappedVersionTimes(doc, now.getTime()),
    missing,
    recent,
    missingCount,
    recentCount: recentAll,
    truncated,
    tombstone,
    unpublishedAt: unpublish?.at ?? null,
    unpublishedBy: unpublish?.by ?? null,
    unpublishedVersions: unpublish?.versions ?? [],
    securityHolder: holder,
    isNew,
    installScriptVersions,
    packumentKey,
    flags,
  };
}

/**
 * Retention rule. Storing every packument would be 3.54 GB/day and exhaust the
 * free tier in under three days, so this is the single most load-bearing cost
 * decision in the project — and the first live run showed "any flag at all" is
 * far too generous.
 *
 * Retained: the cases where the packument is SMALL and IRREPLACEABLE.
 *   new_package        the origin record, one version, ~3.4 KB
 *   package_unpublished the death certificate — a tombstone is a few hundred bytes
 *   security_holder    npm's own takeover marker, tiny
 *   install_scripts    the classic malware vector, worth its ~42 KB
 *
 * Deliberately NOT retained:
 *   version_unpublished  on an ESTABLISHED package. The packument averages 165 KB,
 *                        and the observation row already carries the yanked version,
 *                        its original publish time and its integrity hash. The
 *                        tarball is 404 at npm either way, so the extra bytes buy
 *                        almost no forensic depth. (A yank on a new package still
 *                        gets retained, via new_package.)
 *   high_churn           the largest packuments and the least interesting: automated
 *                        release bots, not supply-chain events.
 */
const RETAIN_FLAGS = ['new_package', 'package_unpublished', 'install_scripts'];

export function shouldRetainPackument(obs: Pick<Observation, 'flags'>): boolean {
  return obs.flags.some(
    (f) => RETAIN_FLAGS.includes(f) || f.startsWith('security_holder_'),
  );
}

export function gap(
  runId: string,
  kind: Gap['kind'],
  now: Date,
  fields: Partial<Pick<Gap, 'name' | 'seq' | 'rev' | 'status' | 'detail'>> = {},
): Gap {
  return {
    k: 'gap',
    schema: 1,
    run: runId,
    kind,
    name: fields.name ?? null,
    seq: fields.seq ?? null,
    rev: fields.rev ?? null,
    status: fields.status ?? null,
    detail: fields.detail ?? null,
    at: now.toISOString(),
  };
}

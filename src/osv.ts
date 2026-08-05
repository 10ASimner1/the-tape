/**
 * OSV vulnerability and malware records.
 *
 * Enrichment is a JOIN, never a write. Measured on the 130 most recent npm MAL
 * records: the lag from an npm publish to the OSV record becoming RETRIEVABLE is
 * median 3.07h, p90 3.8h, with a 128-day outlier. Enriching a publish at the
 * moment we see it would miss roughly 90% of hits, so the recorder simply mirrors
 * the delta and the nightly index joins it to observations that may be far older.
 * (OSV's own `published` field is misleadingly fast — median two minutes — and is
 * deliberately not used for this.)
 *
 * The delta mechanism is the nice part: `modified_id.csv` is sorted
 * REVERSE-CHRONOLOGICALLY, so a ranged GET of the first few kilobytes yields
 * everything changed since the last run out of an 8.4 MB file.
 */

import { OSV_MODIFIED_CSV, OSV_RECORD_URL } from './config.ts';
import { request, requestJson } from './http.ts';
import { putJsonl } from './jsonl.ts';
import { log } from './log.ts';
import { assertNoPersonalAddresses, hashEmail } from './pii.ts';
import { redactEmailsDeep } from './redact.ts';
import { keys, type Store } from './store.ts';

/** Escalating windows. Most runs are satisfied by the first. */
const RANGE_STEPS = [64 * 1024, 512 * 1024, 0] as const;

export type OsvRecord = {
  readonly id: string;
  readonly modified: string;
  readonly summary?: string;
  readonly affected?: ReadonlyArray<{
    package?: { name?: string; ecosystem?: string };
    versions?: readonly string[];
    ranges?: unknown;
  }>;
  readonly [k: string]: unknown;
};

export type OsvDelta = {
  readonly ids: string[];
  /** Newest `modified` seen. Becomes the next run's watermark. */
  readonly newestModified: string | null;
  /** True when the window reached the watermark, i.e. nothing was missed. */
  readonly complete: boolean;
};

/**
 * Reads the head of the CSV until it passes `watermark`, widening the range if
 * the window was not deep enough.
 */
export async function fetchDelta(watermark: string | null): Promise<OsvDelta> {
  for (const bytes of RANGE_STEPS) {
    const headers = bytes > 0 ? { range: `bytes=0-${bytes - 1}` } : {};
    // 206 Partial Content on a ranged read; 200 when we ask for the whole file.
    const res = await request(OSV_MODIFIED_CSV, { headers, accept: [206] });
    const text = Buffer.from(res.body).toString('utf8');

    const ids: string[] = [];
    let newestModified: string | null = null;
    let reachedWatermark = watermark === null;

    // Drop the final line of a ranged read: it is almost certainly truncated.
    const lines = text.split('\n');
    if (bytes > 0) lines.pop();

    for (const line of lines) {
      const comma = line.indexOf(',');
      if (comma === -1) continue;
      const modified = line.slice(0, comma).trim();
      const id = line.slice(comma + 1).trim();
      if (id.length === 0 || modified.length === 0) continue;

      newestModified ??= modified;
      if (watermark !== null && modified <= watermark) {
        reachedWatermark = true;
        break;
      }
      ids.push(id);
    }

    if (reachedWatermark || bytes === 0) {
      return { ids, newestModified, complete: reachedWatermark };
    }
    log.info('osv delta window too small, widening', { bytes, found: ids.length });
  }
  return { ids: [], newestModified: null, complete: false };
}

/** Fetches one record verbatim. Records are small and individually addressable. */
export async function fetchRecord(id: string): Promise<OsvRecord | null> {
  try {
    return await requestJson<OsvRecord>(`${OSV_RECORD_URL}/${encodeURIComponent(id)}.json`);
  } catch (err) {
    log.warn('osv record fetch failed', { id, kind: (err as Error).name });
    return null;
  }
}

export type OsvSyncResult = {
  readonly fetched: number;
  readonly watermark: string | null;
  readonly key: string | null;
  readonly complete: boolean;
};

/**
 * Mirrors every OSV record modified since the watermark into the archive.
 *
 * Records are stored VERBATIM. They are third-party evidence and reshaping them
 * would cost exactly the fidelity that makes them worth keeping — the join
 * happens at index time against a copy we control.
 *
 * The watermark only advances when the window actually reached it. A partial
 * sync leaves it where it was, so the next run re-reads rather than skipping.
 */
export async function syncOsv(
  store: Store,
  watermark: string | null,
  now: Date,
  runId: string,
  maxRecords = 2_000,
): Promise<OsvSyncResult> {
  const delta = await fetchDelta(watermark);
  if (delta.ids.length === 0) {
    log.info('osv up to date', { watermark });
    return { fetched: 0, watermark, key: null, complete: delta.complete };
  }

  const ids = delta.ids.slice(0, maxRecords);
  if (ids.length < delta.ids.length) {
    log.warn('osv delta capped for this run', { total: delta.ids.length, taken: ids.length });
  }

  const records: OsvRecord[] = [];
  for (const id of ids) {
    const record = await fetchRecord(id);
    if (record !== null) records.push(record);
  }
  if (records.length === 0) return { fetched: 0, watermark, key: null, complete: false };

  const key = keys.osv(now, runId);

  // OSV records carry personal addresses, and this path did not redact them.
  //
  // MEASURED on the archive 2026-08-05: 1,022 raw addresses across 848 of 2,786
  // stored records, with ZERO salted hashes — while raw/obs, raw/feed and
  // private/pkg held 0 addresses and 266,000+ hashes between them. This was the
  // only putJsonl caller that passed no guard, and it is the reason that
  // parameter is now required rather than optional.
  //
  // The addresses live in `credits[].contact[]` (which pii.ts's own header names
  // as the field a careful enumeration missed), in `details` free text, and in
  // `database_specific` URLs — so this redacts byte-level over every string
  // rather than naming fields, exactly as packuments do.
  //
  // The gate is the address rule rather than the strict one, for the same reason
  // retained packuments use it: these are third-party documents archived close to
  // verbatim, and reshaping them to satisfy a key-NAME rule would cost fidelity
  // and protect nobody. The address rule still applies in full.
  const redacted = records.map((r) => redactEmailsDeep(r, hashEmail));
  await putJsonl(store, key, redacted, assertNoPersonalAddresses);
  log.info('osv delta stored', {
    key, records: records.length, mal: records.filter((r) => r.id.startsWith('MAL-')).length,
  });

  // Only advance if the whole window was covered AND nothing was capped away.
  const advanced = delta.complete && ids.length === delta.ids.length;
  return {
    fetched: records.length,
    watermark: advanced ? delta.newestModified ?? watermark : watermark,
    key,
    complete: advanced,
  };
}

export type AffectsBasis =
  /** An explicit version list — the join is exact. */
  | 'explicit'
  /** The record expressed affected versions as RANGES. We store the package-level
   *  row but the version set is NOT enumerated, so a join on this row means
   *  "somewhere in this package", not "every version of it". */
  | 'range'
  /** No version information at all. Common and expected: ~11% of recently
   *  malicious packages already 404, so there is no version list to be had. */
  | 'unknown';

export type OsvAffects = {
  readonly osvId: string;
  readonly name: string;
  readonly version: string | null;
  readonly basis: AffectsBasis;
};

/**
 * Flattens a record to the (package, version) pairs it concerns.
 *
 * The `basis` matters: collapsing a range-only record into a bare package-level
 * row makes it indistinguishable from "we know nothing about versions", and a
 * consumer would reasonably read that as every version being affected. Recording
 * which of the three cases produced the row keeps the claim honest.
 */
export function affectsOf(record: OsvRecord): OsvAffects[] {
  const out: OsvAffects[] = [];
  for (const affected of record.affected ?? []) {
    const name = affected.package?.name;
    if (typeof name !== 'string' || affected.package?.ecosystem !== 'npm') continue;

    const versions = affected.versions ?? [];
    if (versions.length > 0) {
      for (const v of versions) out.push({ osvId: record.id, name, version: v, basis: 'explicit' });
      continue;
    }
    const hasRanges = Array.isArray(affected.ranges) && affected.ranges.length > 0;
    out.push({ osvId: record.id, name, version: null, basis: hasRanges ? 'range' : 'unknown' });
  }
  return out;
}

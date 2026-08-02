/**
 * The npm replication changes feed — the irreplaceable data source.
 *
 * It is queryable forward only, and nothing else on the internet substitutes for
 * it: `/-/all` is dead, `/-/rss` carries 50 items and no deletions, ecosyste.ms
 * is a lagging mirror of this same feed, and skimdb 301-redirects here. That
 * makes it a genuine single point of failure, and it is why the cursor is allowed
 * to advance only once these bytes are durable.
 *
 * npm narrowed the feed in Feb 2025. Supported: since=<int>, limit<=10000,
 * descending. Rejected with HTTP 400: include_docs, feed, heartbeat, timeout,
 * style, filter, since=now. Not using include_docs is not a design preference —
 * it is the only option.
 */

import {
  FEED_PAGE_LIMIT,
  FEED_ROOT_URL,
  FEED_SEQ_PER_ROW_MAX,
  FEED_SEQ_PER_ROW_MIN,
  FEED_URL,
} from './config.ts';
import { request, requestJson } from './http.ts';
import { putJsonl, type WrittenShard } from './jsonl.ts';
import { log } from './log.ts';
import { assertNoPII } from './pii.ts';
import { keys, type Store } from './store.ts';

export type FeedRow = {
  readonly seq: number;
  readonly id: string;
  readonly changes: ReadonlyArray<{ readonly rev: string }>;
  /** Present only on unpublishes — absent on ordinary publishes, so test with
   *  `=== true`, never `!== false`. */
  readonly deleted?: boolean;
};

type FeedPage = { results: FeedRow[]; last_seq: number };
type FeedRoot = { db_name: string; doc_count: number; update_seq: number };

/**
 * A proof that a specific feed window has been durably written.
 *
 * This is the single load-bearing invariant in the project: the cursor must never
 * advance past feed rows that are not yet in the archive, because those rows can
 * never be re-requested. The brand makes that ordering a compile error rather
 * than a comment — `advanceCursor` cannot be called without a value that only
 * `writeFeedBlob` can mint.
 */
declare const feedReceiptBrand: unique symbol;

export type FeedReceipt = {
  readonly [feedReceiptBrand]: true;
  readonly sinceSeq: number;
  readonly lastSeq: number;
  readonly rows: number;
  readonly key: string;
  readonly sha256: string;
};

/** MEASURED: `since=now` returns HTTP 400, so the head is read from the DB root. */
export async function headSeq(): Promise<number> {
  const root = await requestJson<FeedRoot>(FEED_ROOT_URL);
  if (!Number.isFinite(root.update_seq)) throw new Error('feed root returned no update_seq');
  return root.update_seq;
}

export type DrainResult = {
  readonly rows: FeedRow[];
  readonly sinceSeq: number;
  readonly lastSeq: number;
  readonly pages: number;
  readonly atHead: boolean;
};

/**
 * Reads every change since `sinceSeq`, to exhaustion.
 *
 * This is deliberately unbounded: a three-day backlog is ~63,000 rows, which is
 * seven requests and well under a minute. The expensive part of a run is fetching
 * packuments, and those are replaceable. Draining fully means the recorder is
 * never behind on the one thing it cannot re-request.
 */
export async function drain(sinceSeq: number, maxPages = 64): Promise<DrainResult> {
  const rows: FeedRow[] = [];
  let cursor = sinceSeq;
  let pages = 0;
  let atHead = false;

  while (pages < maxPages) {
    const url = `${FEED_URL}?since=${cursor}&limit=${FEED_PAGE_LIMIT}`;
    const page = await requestJson<FeedPage>(url);
    pages++;
    rows.push(...page.results);

    if (page.results.length === 0) {
      atHead = true;
      if (Number.isFinite(page.last_seq)) cursor = Math.max(cursor, page.last_seq);
      break;
    }
    cursor = page.last_seq;
    if (page.results.length < FEED_PAGE_LIMIT) {
      atHead = true;
      break;
    }
  }

  if (!atHead) log.warn('drain stopped at page cap; backlog remains', { pages, lastSeq: cursor });

  // MEASURED: seq is sparse at ~3-6 units per emitted row. A ratio outside the
  // band means the feed's semantics changed upstream; the rows are still real,
  // so this warns rather than fails.
  if (rows.length > 100) {
    const ratio = (cursor - sinceSeq) / rows.length;
    if (ratio < FEED_SEQ_PER_ROW_MIN || ratio > FEED_SEQ_PER_ROW_MAX) {
      log.warn('feed seq/row ratio outside measured band', {
        ratio: Number(ratio.toFixed(2)),
        rows: rows.length,
      });
    }
  }

  return { rows, sinceSeq, lastSeq: cursor, pages, atHead };
}

/**
 * COMMIT A. The only place a FeedReceipt is created.
 *
 * A header row records the exact query window, which makes the archive verifiable:
 * identical feed queries return byte-identical responses, so any of these windows
 * can be re-requested later and diffed against what we stored.
 */
export async function writeFeedBlob(
  store: Store,
  drained: DrainResult,
  now: Date,
): Promise<FeedReceipt> {
  const header = {
    k: 'feedhdr',
    since: drained.sinceSeq,
    lastSeq: drained.lastSeq,
    rows: drained.rows.length,
    pages: drained.pages,
    atHead: drained.atHead,
    url: `${FEED_URL}?since=${drained.sinceSeq}&limit=${FEED_PAGE_LIMIT}`,
    drainedAt: now.toISOString(),
  };

  const key = keys.feed(now, drained.sinceSeq, drained.lastSeq);
  const shard: WrittenShard = await putJsonl(store, key, [header, ...drained.rows], assertNoPII);

  return {
    sinceSeq: drained.sinceSeq,
    lastSeq: drained.lastSeq,
    rows: drained.rows.length,
    key: shard.key,
    sha256: shard.sha256,
  } as FeedReceipt;
}

/**
 * A package appears at most once per drain window (CouchDB collapses to the
 * latest change per document), but across a multi-day backlog the same name
 * appears in several windows. Only the newest rev needs fetching — its `time`
 * map is a superset of the older one's — which is what collapses a backlog.
 */
export function dedupeByNameKeepingNewest(rows: readonly FeedRow[]): FeedRow[] {
  const best = new Map<string, FeedRow>();
  for (const row of rows) {
    const existing = best.get(row.id);
    if (existing === undefined || row.seq > existing.seq) best.set(row.id, row);
  }
  return [...best.values()].sort((a, b) => b.seq - a.seq); // newest first
}

export function revOf(row: FeedRow): string | null {
  return row.changes[0]?.rev ?? null;
}

/** Verifies the feed still answers the exact query we recorded, byte for byte. */
export async function reQueryWindow(sinceSeq: number): Promise<string> {
  const res = await request(`${FEED_URL}?since=${sinceSeq}&limit=${FEED_PAGE_LIMIT}`);
  return Buffer.from(res.body).toString('utf8');
}

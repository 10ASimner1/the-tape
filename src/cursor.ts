/**
 * The entire durable mutable state of the recorder: one small JSON object.
 *
 * Note what is NOT here: no per-package table, and no global "emit versions newer
 * than X" watermark. Both were considered and both are traps. A watermark that
 * advances while a fetch backlog drains silently drops every event behind it, and
 * the failure is invisible. Instead the observation row carries the packument's
 * own absolute `time` map, and which versions are NEW is decided offline by the
 * index, which has every prior observation in hand. There is nothing here to
 * outrun.
 */

import type { FeedReceipt } from './feed.ts';
import { keys, type Store } from './store.ts';

export type Cursor = {
  readonly schema: 1;
  /** Last feed seq whose rows are durably written. */
  readonly lastSeq: number;
  readonly lastRunId: string | null;
  readonly lastRunCompletedAt: string | null;
  /** OSV `modified` timestamp of the oldest record fully written. */
  readonly osvWatermark: string | null;
  readonly bytesWrittenMonth: number;
  readonly monthKey: string;
  /**
   * The feed window whose packuments are still being fetched.
   *
   * Set at COMMIT B and cleared at the end of the run. If a run dies in between —
   * a crash, a runner timeout, a cancelled job — the next run finds this set and
   * re-queues those names from the archived feed blob.
   *
   * Without it, "delay, not loss" was only an aspiration: the cursor advances
   * before packuments are fetched (deliberately, because the feed is the
   * irreplaceable half), so a mid-fetch death left those packages unobserved with
   * nothing to point back at them. This is what makes the claim true.
   */
  readonly pendingFeedKey: string | null;
};

export class CursorRegressionError extends Error {
  constructor(from: number, to: number) {
    super(
      `refusing to move the cursor backwards: ${from} -> ${to}. ` +
        `Moving forward past unwritten rows loses events permanently; moving backwards ` +
        `only causes duplicates, but it is never done implicitly. Use recover-cursor ` +
        `to re-derive from the archive, or pass --force-rewind deliberately.`,
    );
    this.name = 'CursorRegressionError';
  }
}

export function initial(headSeq: number, now: Date): Cursor {
  return {
    schema: 1,
    lastSeq: headSeq,
    lastRunId: null,
    lastRunCompletedAt: null,
    osvWatermark: null,
    bytesWrittenMonth: 0,
    monthKey: monthKeyOf(now),
    pendingFeedKey: null,
  };
}

export function monthKeyOf(date: Date): string {
  return date.toISOString().slice(0, 7);
}

/**
 * COMMIT B, and the reason FeedReceipt exists.
 *
 * This signature is the invariant: the cursor cannot advance without proof that
 * the feed window is already in the archive, because a `FeedReceipt` can only be
 * minted by `writeFeedBlob`. Every failure window in the run therefore produces
 * duplicates, and none produces loss.
 */
export function advance(cursor: Cursor, receipt: FeedReceipt, now: Date): Cursor {
  if (receipt.lastSeq < cursor.lastSeq) {
    throw new CursorRegressionError(cursor.lastSeq, receipt.lastSeq);
  }
  const month = monthKeyOf(now);
  return {
    ...cursor,
    lastSeq: receipt.lastSeq,
    // Claim this window as in-flight. Cleared only once the run finishes.
    pendingFeedKey: receipt.key,
    // Byte accounting resets with the billing month. Object stores generally bill
    // overage rather than hard-stopping, so the recorder has to stop itself.
    bytesWrittenMonth: month === cursor.monthKey ? cursor.bytesWrittenMonth : 0,
    monthKey: month,
  };
}

export function withRunComplete(cursor: Cursor, runId: string, now: Date, bytes: number): Cursor {
  return {
    ...cursor,
    lastRunId: runId,
    lastRunCompletedAt: now.toISOString(),
    // The window is no longer in flight — whatever was not fetched is in
    // work/deferred by this point.
    pendingFeedKey: null,
    bytesWrittenMonth: cursor.bytesWrittenMonth + bytes,
  };
}

export function withOsvWatermark(cursor: Cursor, watermark: string): Cursor {
  return { ...cursor, osvWatermark: watermark };
}

// ── Persistence ──────────────────────────────────────────────────────────────
// M1 keeps the cursor in the blob store. M2 moves it to an orphan git branch,
// where a non-fast-forward push rejection becomes the compare-and-swap between
// overlapping runs — a primitive B2's S3 layer does not offer.

/**
 * Fills in fields added since the stored cursor was written.
 *
 * An archive that runs for years will read cursors written by older code, and a
 * missing field arrives as `undefined` rather than the `null` the type promises.
 * That exact gap took the recorder down: a new `pendingFeedKey` field read back
 * as `undefined`, passed a `!== null` check, and the resulting `get(undefined)`
 * fetched a bucket listing that then failed to gunzip. Normalising on read makes
 * the type honest instead of relying on every call site guessing correctly.
 */
function normalize(raw: Partial<Cursor>, now: Date): Cursor {
  return {
    schema: 1,
    lastSeq: raw.lastSeq ?? 0,
    lastRunId: raw.lastRunId ?? null,
    lastRunCompletedAt: raw.lastRunCompletedAt ?? null,
    osvWatermark: raw.osvWatermark ?? null,
    bytesWrittenMonth: raw.bytesWrittenMonth ?? 0,
    monthKey: raw.monthKey ?? monthKeyOf(now),
    pendingFeedKey: raw.pendingFeedKey ?? null,
  };
}

export async function read(store: Store, now = new Date()): Promise<Cursor | null> {
  const bytes = await store.get(keys.cursor());
  if (bytes === null) return null;
  const raw = JSON.parse(Buffer.from(bytes).toString('utf8')) as Partial<Cursor>;
  if (typeof raw.lastSeq !== 'number' || !Number.isFinite(raw.lastSeq)) {
    throw new Error('stored cursor has no usable lastSeq; run recover-cursor');
  }
  return normalize(raw, now);
}

export async function write(store: Store, cursor: Cursor): Promise<void> {
  await store.put(keys.cursor(), Buffer.from(`${JSON.stringify(cursor, null, 2)}\n`, 'utf8'));
}

/**
 * The cursor is a cache of the archive, not the source of truth. If it is lost or
 * clobbered, the true position is the highest seq we actually wrote, which is
 * recoverable exactly from the feed object keys.
 */
export async function recoverFromArchive(store: Store): Promise<number | null> {
  const objects = await store.list('raw/feed/');
  let max: number | null = null;
  for (const { key } of objects) {
    const m = /\/(\d+)-(\d+)\.jsonl\.gz$/.exec(key);
    if (m?.[2] === undefined) continue;
    const last = Number(m[2]);
    if (Number.isFinite(last) && (max === null || last > max)) max = last;
  }
  return max;
}

/** Guards against a cursor that has somehow moved past the live registry head. */
export function assertSane(cursor: Cursor, head: number): void {
  if (cursor.lastSeq > head) {
    throw new Error(
      `cursor.lastSeq (${cursor.lastSeq}) is ahead of the live feed head (${head}). ` +
        `The cursor was clobbered forward, which is the one direction that loses events. ` +
        `Run recover-cursor to re-derive it from the archive.`,
    );
  }
}

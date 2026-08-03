/**
 * The self-imposed spend cap.
 *
 * Object stores bill overage rather than hard-stopping, so the recorder has to
 * stop itself. It could not, and README said so.
 *
 * THE CAP IS GRADED, NOT BINARY, and that is the whole design. Refusing to write
 * the feed blob is the one refusal in this system that loses data permanently —
 * the changes feed is queryable forward only and has no substitute anywhere on
 * the internet. Everything else the recorder writes is re-derivable from rows it
 * already holds, or re-fetchable from npm. So the ladder gives up the
 * discretionary things first and never, at any tier, gives up capture:
 *
 *   normal  everything
 *   soft    retain only the packuments that cannot be re-fetched
 *   hard    feed only, via the triage path that already exists
 *
 * Feed-only is well under a megabyte a day gzipped, so even a fully exhausted
 * budget keeps the irreplaceable half running for years.
 *
 * What bills is CUMULATIVE STORED BYTES, not bytes written this month. The
 * archive is append-only, so every byte ever written is still being billed for;
 * a monthly write counter would read near-zero the day the tier is exhausted.
 * That is why the anchor is a real measurement of the bucket and not a running
 * total.
 */

import { BUDGET_HARD_FRACTION, BUDGET_SOFT_FRACTION, STORAGE_FREE_TIER_BYTES } from './config.ts';
import type { FeedReceipt } from './feed.ts';
import { keys, type Store } from './store.ts';

/** A measurement of what the bucket actually holds. Ground truth for the cap. */
export type Usage = {
  readonly schema: 1;
  /** Σ StoreObject.size over the WHOLE store — including work/ and state/, which
   *  bill too even though the mirror does not copy them. */
  readonly storedBytes: number;
  readonly objects: number;
  readonly measuredAt: string;
  /** Per top-level prefix, so a human can see what is consuming the tier rather
   *  than being told only that it is nearly gone. */
  readonly byPrefix: Readonly<Record<string, { objects: number; bytes: number }>>;
};

export type Tier = 'normal' | 'soft' | 'hard';

export function ceilingBytes(env: NodeJS.ProcessEnv): number {
  const raw = env['TAPE_STORAGE_CEILING_BYTES'];
  if (raw === undefined || raw.length === 0) return STORAGE_FREE_TIER_BYTES;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(
      `TAPE_STORAGE_CEILING_BYTES is "${raw}", which is not a positive number of bytes. ` +
        `Set it to the plan's storage allowance, or unset it to use the free tier.`,
    );
  }
  return n;
}

/**
 * Decides how much of itself the run is allowed to be.
 *
 * It takes a FeedReceipt it never reads, and that is deliberate: a receipt can
 * only be minted by writeFeedBlob, so the budget CANNOT be evaluated before the
 * feed is already durable. A future edit that tries to move the cap in front of
 * COMMIT A is a compile error rather than a code review. Same technique as
 * cursor.advance(), for the same reason and with the same weight behind it.
 */
export function tierFor(
  _receipt: FeedReceipt,
  storedBytes: number,
  ceiling: number,
): Tier {
  if (storedBytes >= ceiling * BUDGET_HARD_FRACTION) return 'hard';
  if (storedBytes >= ceiling * BUDGET_SOFT_FRACTION) return 'soft';
  return 'normal';
}

export async function read(store: Store): Promise<Usage | null> {
  const bytes = await store.get(keys.usage());
  if (bytes === null) return null;
  const parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) as Partial<Usage>;
  if (typeof parsed.storedBytes !== 'number' || !Number.isFinite(parsed.storedBytes)) return null;
  return {
    schema: 1,
    storedBytes: parsed.storedBytes,
    objects: parsed.objects ?? 0,
    measuredAt: parsed.measuredAt ?? new Date(0).toISOString(),
    byPrefix: parsed.byPrefix ?? {},
  };
}

export async function write(store: Store, usage: Usage): Promise<void> {
  await store.put(keys.usage(), Buffer.from(`${JSON.stringify(usage, null, 2)}\n`, 'utf8'));
}

/**
 * Measures the bucket by listing all of it and summing object sizes.
 *
 * Expensive and therefore nightly, not hourly. This is the only number in the
 * project that is allowed to decide whether the recorder degrades itself, so it
 * is measured rather than projected — the same rule that governs the two
 * retention constants, and for the same reason: a storage estimate made at a
 * desk was wrong by 13x once already.
 */
export async function measure(store: Store, now: Date): Promise<Usage> {
  const objects = await store.list('');
  const byPrefix: Record<string, { objects: number; bytes: number }> = {};
  let storedBytes = 0;

  for (const object of objects) {
    const top = `${object.key.split('/')[0] ?? '(root)'}/`;
    const bucket = byPrefix[top] ?? { objects: 0, bytes: 0 };
    bucket.objects++;
    bucket.bytes += object.size;
    byPrefix[top] = bucket;
    storedBytes += object.size;
  }

  return {
    schema: 1,
    storedBytes,
    objects: objects.length,
    measuredAt: now.toISOString(),
    byPrefix,
  };
}

export type Estimate = {
  readonly storedBytes: number;
  readonly ceiling: number;
  readonly tier: Tier;
  /** No anchor at all, or one too old to trust. Either way the cap is not really
   *  working and the operator needs to know — but neither ever fails a run. */
  readonly anchored: boolean;
  readonly stale: boolean;
};

/** Decimal units, because that is how storage tiers are quoted — reading a
 *  decimal tier as binary would overstate the headroom by 7.4%. */
export function humanBytes(n: number): string {
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${i === 0 ? v : v.toFixed(2)} ${units[i]}`;
}

export function describe(estimate: Estimate): string {
  const pct = Math.round((estimate.storedBytes / estimate.ceiling) * 100);
  const note = !estimate.anchored ? ' — NOT ANCHORED' : estimate.stale ? ' — anchor is stale' : '';
  return `${humanBytes(estimate.storedBytes)} / ${humanBytes(estimate.ceiling)} ` +
    `(${pct}%), tier: ${estimate.tier}${note}`;
}

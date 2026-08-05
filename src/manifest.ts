/**
 * The run manifest: what a run wrote, and the hash of each thing it wrote.
 *
 * This module exists for one reason — there must be exactly ONE definition of a
 * manifest's canonical bytes. The recorder writes them and the ledger verifier
 * re-derives them, and two independent notions of "canonical" is how a hash
 * ledger starts failing for no reason at all. Both sides import from here.
 *
 * `JSON.stringify(m, null, 2)` is insertion-order dependent, so FIELD ORDER IN
 * THE OBJECT LITERAL IS PART OF THE FORMAT. Adding a field in the middle changes
 * every hash after it. Append.
 */

import { sha256Hex, type WrittenShard } from './jsonl.ts';

export type RunManifest = {
  readonly runId: string;
  /**
   * 1 — `retained` was one entry per packument, each its own object.
   * 2 — `retained` is a list of SHARDS, the same shape as `obsShards`, and the
   *     per-item sha256 moved into the rows inside them.
   *
   * Nothing reads this. It is an honesty marker so a reader meeting an old
   * manifest can tell why the element shape differs.
   *
   * This comment used to claim "both eras still satisfy ledger.ts's object
   * arithmetic". That was wrong, and the omission cost a night's digest: it
   * forgot the era BEFORE `retained` existed at all, whose manifests are still
   * sitting in the bucket and always will be. `readManifests` now defaults the
   * field rather than trusting any claim made here. In an append-only archive
   * every shape ever written stays readable forever — count the eras, then
   * default anyway.
   */
  readonly schema: 1 | 2;
  /** The chain. `null` means "chain begins here": genesis, a manifest written
   *  before the chain existed, or the run after a `recover-cursor`. */
  readonly prevRunId: string | null;
  readonly prevManifestSha256: string | null;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly sinceSeq: number;
  readonly lastSeq: number;
  readonly mode: 'steady' | 'backlog' | 'triage';
  readonly feedBlob: {
    readonly key: string;
    readonly sha256: string;
    readonly rows: number;
    readonly rawBytes: number;
    readonly gzBytes: number;
  };
  readonly obsShards: readonly WrittenShard[];
  /** Kept under this name across the schema change on purpose: renaming it would
   *  break ledger.readManifests against every manifest already in the bucket. */
  readonly retained: readonly WrittenShard[];
  readonly queued: number;
  readonly fetched: number;
  readonly deferred: number;
  /** What the storage budget allowed this run to be, and the numbers behind it.
   *  Recorded so a degraded run is explicable years later from the archive
   *  alone, rather than only from a log line that has long since rotated. */
  readonly budget: {
    readonly tier: 'normal' | 'soft' | 'hard';
    readonly storedBytes: number;
    readonly ceiling: number;
    readonly triageReason: 'queue' | 'budget' | null;
  };
  /** Everything the run wrote EXCEPT this manifest — a file cannot state its own
   *  size. The cursor's counter is the one that includes it. */
  readonly bytesWritten: number;
};

/** The exact bytes a manifest is stored as. Nothing may write a manifest by any
 *  other route, or the ledger's hashes stop matching the archive. */
export function canonicalManifestBytes(manifest: RunManifest): Buffer {
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

export function manifestSha256(bytes: Uint8Array): string {
  return sha256Hex(bytes);
}

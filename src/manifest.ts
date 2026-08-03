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
import type { RetainedPackument } from './run.ts';

export type RunManifest = {
  readonly runId: string;
  readonly schema: 1;
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
  readonly retained: readonly RetainedPackument[];
  readonly queued: number;
  readonly fetched: number;
  readonly deferred: number;
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

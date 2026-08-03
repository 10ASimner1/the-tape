/**
 * Gzipped JSONL shard writer.
 *
 * Sharding bounds the blast radius of a mid-run kill: at most one shard's worth
 * of in-flight rows is lost, and those names are still in raw/feed, so the next
 * run reconstructs them. Delay, not loss.
 */

import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

import { SHARD_MAX_BYTES, SHARD_MAX_ROWS } from './config.ts';
import type { Store } from './store.ts';

export type WrittenShard = {
  readonly key: string;
  readonly rows: number;
  /** sha256 of the UNCOMPRESSED canonical bytes.
   *  gzip output varies with zlib version and embedded mtime, so hashing the
   *  compressed blob would raise false tamper alarms after a runner image
   *  upgrade — and a manifest that cries wolf is a manifest nobody reads. */
  readonly sha256: string;
  readonly rawBytes: number;
  readonly gzBytes: number;
};

export function encodeJsonl(rows: readonly unknown[]): string {
  return rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length > 0 ? '\n' : '');
}

export function decodeJsonl<T>(text: string): T[] {
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as T);
}

export function sha256Hex(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes as never).digest('hex');
}

/** One-shot: encode, gzip, hash and store a complete set of rows. */
export async function putJsonl(
  store: Store,
  key: string,
  rows: readonly unknown[],
  guard?: (bytes: string, where: string) => void,
): Promise<WrittenShard> {
  const text = encodeJsonl(rows);
  guard?.(text, key);
  const gz = gzipSync(Buffer.from(text, 'utf8'), { level: 9 });
  await store.put(key, gz);
  return {
    key,
    rows: rows.length,
    sha256: sha256Hex(text),
    rawBytes: Buffer.byteLength(text, 'utf8'),
    gzBytes: gz.length,
  };
}

/** Accumulates rows and flushes a shard whenever either limit is reached. */
export class ShardWriter {
  readonly #store: Store;
  readonly #keyFor: (part: number) => string;
  readonly #guard: ((bytes: string, where: string) => void) | undefined;
  #buffer: unknown[] = [];
  #bufferBytes = 0;
  #part = 0;
  readonly #written: WrittenShard[] = [];

  constructor(
    store: Store,
    keyFor: (part: number) => string,
    guard?: (bytes: string, where: string) => void,
  ) {
    this.#store = store;
    this.#keyFor = keyFor;
    this.#guard = guard;
  }

  /**
   * The key the NEXT row added will land in.
   *
   * Safe because `add()` pushes before it tests the limits, so a row always ends
   * up in the part this returned before the call — including the row that trips
   * the flush, and including a single row larger than SHARD_MAX_BYTES. There is
   * no case where it lands in part N+1.
   *
   * Read it immediately before `add()`, never earlier: a caller that reads this,
   * then decides to skip the row, would stamp a pointer at a shard that does not
   * contain it.
   */
  get pendingKey(): string {
    return this.#keyFor(this.#part);
  }

  async add(row: unknown): Promise<void> {
    this.#buffer.push(row);
    this.#bufferBytes += JSON.stringify(row).length + 1;
    if (this.#buffer.length >= SHARD_MAX_ROWS || this.#bufferBytes >= SHARD_MAX_BYTES) {
      await this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.#buffer.length === 0) return;
    const rows = this.#buffer;
    this.#buffer = [];
    this.#bufferBytes = 0;
    this.#written.push(await putJsonl(this.#store, this.#keyFor(this.#part++), rows, this.#guard));
  }

  get shards(): readonly WrittenShard[] {
    return this.#written;
  }

  get rowCount(): number {
    return this.#written.reduce((n, s) => n + s.rows, 0);
  }
}

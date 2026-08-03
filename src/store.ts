/**
 * The blob store, and nothing else.
 *
 * Three operations plus a conditional write. Keeping the surface this small is
 * what makes the provider a one-file decision rather than an architectural one —
 * R2, B2, S3 and the local filesystem all satisfy it, so M1 runs entirely on disk
 * and the provider choice blocks nothing.
 */

export type StoreObject = {
  readonly key: string;
  readonly size: number;
};

export interface Store {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, body: Uint8Array): Promise<void>;
  /** Write only if the key is absent. With content-addressed keys this makes a
   *  re-fetch after a crash physically idempotent: it writes nothing. */
  putIfAbsent(key: string, body: Uint8Array): Promise<{ written: boolean }>;
  list(prefix: string): Promise<StoreObject[]>;
  delete(key: string): Promise<void>;
}

/**
 * Package names contain `@` and `/` and are 77.5% scoped, so they are never
 * interpolated into a key raw — that would create phantom prefixes and break any
 * code that stages to a local path before uploading.
 */
export function encodeName(name: string): string {
  return encodeURIComponent(name);
}

export function decodeName(encoded: string): string {
  return decodeURIComponent(encoded);
}

/** Run ids are filesystem-safe: no colons, which Windows rejects in filenames. */
export function runIdFrom(date: Date): string {
  return date.toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, 'Z');
}

export function datePath(date: Date): string {
  const iso = date.toISOString();
  return `${iso.slice(0, 4)}/${iso.slice(5, 7)}/${iso.slice(8, 10)}`;
}

// ── Key layout ───────────────────────────────────────────────────────────────
// Nothing here is derived from the wall-clock hour. GitHub cancels a pending run
// rather than queueing it and drops scheduled runs under load, so an object named
// by hour would silently gain holes. Keys are named by (run id, seq range).

export const keys = {
  cursor: () => 'state/cursor.json',

  /** The irreplaceable file: verbatim feed rows. The one thing that cannot be re-fetched. */
  feed: (date: Date, sinceSeq: number, lastSeq: number) =>
    `raw/feed/${datePath(date)}/${sinceSeq}-${lastSeq}.jsonl.gz`,

  /** Self-sufficient observation extracts — what the index is rebuilt from. */
  obs: (date: Date, runId: string, part: number) =>
    `raw/obs/${datePath(date)}/${runId}/part-${String(part).padStart(3, '0')}.jsonl.gz`,

  osv: (date: Date, runId: string) => `raw/osv/${datePath(date)}/${runId}.jsonl.gz`,

  /**
   * Names the fetch phase did not reach.
   *
   * A single key that each run OVERWRITES, rather than one file per run that is
   * later deleted. That is what lets the recorder run on a credential with no
   * delete capability at all — Part III wants no automation credential able to
   * erase history, and removing the requirement beats managing it.
   *
   * Safe because it is a cache, not a record: if a run dies before rewriting it,
   * the stale contents are simply re-processed, and the authoritative list of
   * names is in raw/feed either way.
   */
  deferred: () => 'work/deferred/current.jsonl.gz',

  /** Fixed key, overwritten on every check, so probing leaves no litter behind. */
  selfCheck: () => 'state/selfcheck/probe.txt',

  manifest: (date: Date, runId: string) => `raw/runs/${datePath(date)}/${runId}.json`,

  /** Content-keyed by (name, rev), so putIfAbsent gives physical idempotency. */
  packument: (name: string, rev: string) =>
    `private/pkg/${encodeName(name)}/${encodeURIComponent(rev)}.json.gz`,
};

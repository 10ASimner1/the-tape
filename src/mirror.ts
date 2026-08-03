/**
 * The second copy.
 *
 * Part III §6 wants two copies of the archive at all times, on independent
 * providers with independent credentials and independent billing. The threat is
 * not a subtle attacker; it is a closed or compromised account taking the whole
 * moat with it.
 *
 * This is a SEPARATE mode rather than a dual-write in the run loop, for two
 * reasons. A mirror failure must never fail a recording run (rule 1), so a
 * dual-write would have to swallow its own errors — and a write path that
 * swallows errors drifts silently, which means you need a reconcile pass anyway,
 * which is exactly this code. And list-diff-copy is resumable with NO state at
 * all: the diff is recomputed from two listings every time, so an interrupted run
 * needs nothing more than being run again.
 *
 * It is also strictly read-only on the primary. Mirror bookkeeping lives on the
 * mirror, which is both the right place for it (it describes the mirror's
 * contents, and it survives the primary dying) and what lets the job run on a
 * primary credential that cannot write.
 */

import { MIRROR_PREFIXES, MIRROR_PROBE_KEY, MIRROR_STATE_KEY } from './config.ts';
import { sha256Hex } from './jsonl.ts';
import { log } from './log.ts';
import { identityOf, type Store, type StoreObject } from './store.ts';

export type MirrorPrefixReport = {
  readonly prefix: string;
  readonly examined: number;
  readonly copied: number;
  readonly bytes: number;
  /** Present on both sides at different sizes. Never repaired automatically. */
  readonly mismatched: readonly string[];
  /** Listed by the primary but absent when read. Impossible in an append-only
   *  archive, so it is an alarm rather than a retry. */
  readonly vanished: readonly string[];
  readonly complete: boolean;
};

export type MirrorReport = {
  readonly startedAt: string;
  readonly completedAt: string;
  readonly prefixes: readonly MirrorPrefixReport[];
  readonly copied: number;
  readonly bytes: number;
  readonly mismatched: number;
  readonly vanished: number;
  readonly verified: number;
  readonly verifyFailures: readonly string[];
  readonly complete: boolean;
};

export type MirrorOptions = {
  readonly primary: Store;
  readonly mirror: Store;
  readonly now: Date;
  readonly prefixes?: readonly string[];
  /** Stop copying past this. The next run resumes with no state. */
  readonly deadlineMs?: number;
  readonly maxObjects?: number;
  /** Overwrite size-mismatched keys from the primary. Opt-in, never automatic. */
  readonly repair?: boolean;
  /** Deep-verify N objects by hash, or every one of them. */
  readonly verify?: number | 'all';
  /** Skip the same-store probe. Only for tests that already know the answer. */
  readonly skipProbe?: boolean;
};

export type MirrorState = {
  readonly schema: 1;
  readonly lastRunAt: string;
  /** Identity of the primary this mirror was built from. A mirror re-pointed at a
   *  different primary must refuse, not "discover" that everything is missing and
   *  try to copy a second archive on top of the first. */
  readonly primary: { readonly endpoint: string; readonly bucket: string } | null;
  readonly prefixes: Readonly<Record<string, { objects: number; bytes: number; complete: boolean }>>;
  readonly objects: number;
  readonly bytes: number;
};

export class SameStoreError extends Error {
  constructor(detail: string) {
    super(
      `refusing to mirror: the primary and the mirror are the same object store (${detail}). ` +
        `A same-bucket mirror reports "0 missing, in sync" forever, which is a green light ` +
        `for a backup that does not exist.`,
    );
    this.name = 'SameStoreError';
  }
}

/**
 * Proves the two stores are actually distinct, by experiment rather than by
 * configuration.
 *
 * Comparing endpoints and buckets catches the obvious mistake, but not a CNAME,
 * an http/https spelling difference, or two paths that resolve to one directory.
 * So: write a fresh nonce to the mirror and try to read it back from the primary.
 * If it comes back, they are one store.
 *
 * In the failing case this does leave one object on the primary. It is a fixed
 * key under mirror/, outside every prefix anything else reads, and catching this
 * misconfiguration is worth more than the object costs.
 */
export async function assertDistinct(primary: Store, mirror: Store, now: Date): Promise<void> {
  const nonce = sha256Hex(`${now.toISOString()}:${Math.random()}:mirror-probe`);
  await mirror.put(MIRROR_PROBE_KEY, Buffer.from(JSON.stringify({ nonce }), 'utf8'));

  const echo = await primary.get(MIRROR_PROBE_KEY);
  if (echo === null) return;
  const seen = JSON.parse(Buffer.from(echo).toString('utf8')) as { nonce?: string };
  if (seen.nonce === nonce) {
    throw new SameStoreError('a nonce written to the mirror read back from the primary');
  }
}

function index(objects: readonly StoreObject[]): Map<string, number> {
  return new Map(objects.map((o) => [o.key, o.size]));
}

/**
 * Picks which objects to deep-verify: newest, oldest, and a spread between.
 *
 * Uniform random sampling would systematically under-weight both ends, and the
 * ends are where the interesting failures live — newest catches "the copy path
 * broke last week", oldest catches corruption in the earliest runs. The pick is
 * derived from the run's own timestamp, so a report can be reproduced.
 */
export function sampleForVerify(keys: readonly string[], want: number, seed: string): string[] {
  if (want >= keys.length) return [...keys];
  const sorted = [...keys].sort();
  const picked = new Set<string>();
  const ends = Math.max(1, Math.floor(want / 4));

  for (let i = 0; i < ends && i < sorted.length; i++) {
    picked.add(sorted[i]!);
    picked.add(sorted[sorted.length - 1 - i]!);
  }
  // A cheap deterministic walk: a stride coprime-ish with the length, offset by
  // the seed. No randomness, so the same run id always samples the same objects.
  let cursor = Number.parseInt(seed.slice(0, 8), 16) % sorted.length;
  const stride = 1 + (Number.parseInt(seed.slice(8, 16), 16) % Math.max(1, sorted.length - 1));
  while (picked.size < want) {
    picked.add(sorted[cursor]!);
    cursor = (cursor + stride) % sorted.length;
  }
  return [...picked].sort();
}

export async function mirror(opts: MirrorOptions): Promise<MirrorReport> {
  const { primary, mirror: target, now } = opts;
  const startedAt = now.toISOString();
  const prefixes = opts.prefixes ?? MIRROR_PREFIXES;
  const deadline = opts.deadlineMs === undefined ? Infinity : Date.now() + opts.deadlineMs;
  const maxObjects = opts.maxObjects ?? Infinity;

  if (opts.skipProbe !== true) await assertDistinct(primary, target, now);

  const reports: MirrorPrefixReport[] = [];
  const copiedKeys: string[] = [];
  let copiedTotal = 0;
  let bytesTotal = 0;
  let stopped = false;

  for (const prefix of prefixes) {
    if (stopped) {
      reports.push({
        prefix, examined: 0, copied: 0, bytes: 0,
        mismatched: [], vanished: [], complete: false,
      });
      continue;
    }

    const source = await primary.list(prefix);
    const have = index(await target.list(prefix));

    const missing: string[] = [];
    const mismatched: string[] = [];
    for (const object of source) {
      const size = have.get(object.key);
      if (size === undefined) missing.push(object.key);
      // Same key, different size, in an append-only archive: one side is corrupt
      // or truncated, and WHICH side is right is a human decision. Reported, and
      // repaired only when explicitly asked.
      else if (size !== object.size) mismatched.push(object.key);
    }
    missing.sort();

    const vanished: string[] = [];
    let copied = 0;
    let bytes = 0;
    let complete = true;

    for (const key of missing) {
      if (Date.now() >= deadline || copiedTotal + copied >= maxObjects) {
        complete = false;
        stopped = true;
        break;
      }
      const body = await primary.get(key);
      if (body === null) {
        // The primary listed it and then could not produce it. Append-only
        // archives do not do this; something else is wrong.
        vanished.push(key);
        log.error('object vanished between list and get', { key });
        continue;
      }
      await target.putIfAbsent(key, body);
      copiedKeys.push(key);
      copied++;
      bytes += body.length;
    }

    if (opts.repair === true) {
      for (const key of mismatched) {
        const body = await primary.get(key);
        if (body === null) continue;
        await target.put(key, body);
        bytes += body.length;
      }
    }

    copiedTotal += copied;
    bytesTotal += bytes;
    reports.push({ prefix, examined: source.length, copied, bytes, mismatched, vanished, complete });
    log.info('mirrored prefix', {
      prefix, examined: source.length, copied, bytes,
      mismatched: mismatched.length, complete,
    });
  }

  // Deep verification. The routine size check has 100% coverage of a WEAK
  // property; this has near-zero coverage of a STRONG one. Neither substitutes
  // for the other, and a same-length substitution is exactly what the size check
  // cannot see.
  const verifyFailures: string[] = [];
  let verified = 0;
  if (opts.verify !== undefined) {
    const pool = copiedKeys.length > 0
      ? copiedKeys
      : (await Promise.all(prefixes.map((p) => target.list(p)))).flat().map((o) => o.key);
    const want = opts.verify === 'all' ? pool.length : opts.verify;
    for (const key of sampleForVerify(pool, want, sha256Hex(startedAt))) {
      const [a, b] = await Promise.all([primary.get(key), target.get(key)]);
      if (a === null || b === null || sha256Hex(a) !== sha256Hex(b)) verifyFailures.push(key);
      verified++;
    }
    log.info('deep verify', { checked: verified, failures: verifyFailures.length });
  }

  const complete = reports.every((r) => r.complete);
  const report: MirrorReport = {
    startedAt,
    completedAt: new Date().toISOString(),
    prefixes: reports,
    copied: copiedTotal,
    bytes: bytesTotal,
    mismatched: reports.reduce((n, r) => n + r.mismatched.length, 0),
    vanished: reports.reduce((n, r) => n + r.vanished.length, 0),
    verified,
    verifyFailures,
    complete,
  };

  await writeState(target, report, opts);
  return report;
}

async function writeState(
  target: Store,
  report: MirrorReport,
  opts: MirrorOptions,
): Promise<void> {
  const totals = await Promise.all(
    (opts.prefixes ?? MIRROR_PREFIXES).map(async (p) => [p, await target.list(p)] as const),
  );

  const prefixes: Record<string, { objects: number; bytes: number; complete: boolean }> = {};
  let objects = 0;
  let bytes = 0;
  for (const [prefix, listed] of totals) {
    const sum = listed.reduce((n, o) => n + o.size, 0);
    prefixes[prefix] = {
      objects: listed.length,
      bytes: sum,
      complete: report.prefixes.find((r) => r.prefix === prefix)?.complete ?? false,
    };
    objects += listed.length;
    bytes += sum;
  }

  const state: MirrorState = {
    schema: 1,
    lastRunAt: report.completedAt,
    primary: identityOf(opts.primary),
    prefixes,
    objects,
    bytes,
  };
  await target.put(MIRROR_STATE_KEY, Buffer.from(`${JSON.stringify(state, null, 2)}\n`, 'utf8'));
}

/** The configuration-level half of the same-store check. Cheap, runs before any
 *  network call, and catches the mistake people actually make. */
export function assertDistinctConfig(primary: Store, target: Store): void {
  const a = identityOf(primary);
  const b = identityOf(target);
  if (a !== null && b !== null && a.endpoint === b.endpoint && a.bucket === b.bucket) {
    throw new SameStoreError(`both resolve to ${a.bucket} at ${a.endpoint}`);
  }
}

/** Refuses a mirror that was built from a different primary. Copying a second
 *  archive on top of the first would interleave two histories in one bucket. */
export function assertSamePrimary(state: MirrorState | null, primary: Store): void {
  const now = identityOf(primary);
  const was = state?.primary ?? null;
  if (state === null || was === null || now === null) return;
  if (was.endpoint === now.endpoint && was.bucket === now.bucket) return;
  throw new Error(
    `this mirror was built from ${was.bucket} at ${was.endpoint}, but the configured primary is ` +
      `${now.bucket} at ${now.endpoint}. Copying a second archive into it would interleave two ` +
      `histories. Point it back, or start a fresh mirror bucket.`,
  );
}

export async function readState(target: Store): Promise<MirrorState | null> {
  const bytes = await target.get(MIRROR_STATE_KEY);
  if (bytes === null) return null;
  return JSON.parse(Buffer.from(bytes).toString('utf8')) as MirrorState;
}

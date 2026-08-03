/**
 * The hash ledger: manifests, chained, transcribed into git.
 *
 * A manifest on its own is a checksum — it proves the blobs it names have not
 * changed, but nothing stops someone rewriting the manifest too. The chain fixes
 * ordering: each manifest names its parent's hash, so one retroactive edit
 * invalidates every manifest after it.
 *
 * The chain alone is still not enough, and it is worth being precise about why:
 *
 *   THE CHAIN PROVES ORDERING. GIT'S HISTORY PROVES TIMING.
 *
 * Anyone can build a fresh, internally consistent chain. What they cannot do is
 * retroactively put it in a public git history that other people already cloned.
 * So the tamper signal is not "the chain is broken" — it is "a manifest exists in
 * the bucket that was never committed to ledger/ on the day it claims". That is
 * why this transcribes to a public repo rather than just verifying in place.
 *
 * The ledger carries `prev` copied from each manifest, so the chain verifies from
 * the committed files ALONE, with no bucket access at all. Anyone with the repo
 * does not have the credentials, and that is exactly the audience.
 */

import { decodeJsonl, encodeJsonl } from './jsonl.ts';
import { canonicalManifestBytes, manifestSha256, type RunManifest } from './manifest.ts';
import { datePath, type Store } from './store.ts';

export type LedgerHeader = {
  readonly k: 'ledgerhdr';
  readonly schema: 1;
  readonly day: string;
  readonly runs: number;
};

export type LedgerRun = {
  readonly k: 'run';
  readonly runId: string;
  /** sha256 of this manifest's canonical bytes. */
  readonly sha256: string;
  /** The parent's hash, copied from the manifest so the chain checks offline. */
  readonly prev: string | null;
  readonly prevRunId: string | null;
  readonly sinceSeq: number;
  readonly lastSeq: number;
  readonly mode: string;
  /** The feed blob's hash, promoted out of the manifest: it is the irreplaceable
   *  object, so someone handed one in 2030 can check it against git directly. */
  readonly feed: string;
  readonly objects: number;
  readonly bytes: number;
};

export type AnomalyKind =
  /** No parent. Genesis, a pre-chain manifest, or the run after a recover-cursor. */
  | 'chain-start'
  /** Two manifests name the same parent. Normal after a run died between COMMIT C
   *  and COMMIT D — the cursor kept the old parent and the next run reused it. */
  | 'fork'
  /** A fork whose siblings do not look like a dead run: disjoint seq ranges with a
   *  gap between them, which no crash produces. */
  | 'fork-suspicious'
  /** The named parent is absent. A manifest was DELETED. */
  | 'missing-parent'
  /** The named parent exists but rehashes differently. It was EDITED. */
  | 'hash-mismatch';

export type LedgerAnomaly = {
  readonly k: 'anomaly';
  readonly kind: AnomalyKind;
  readonly runId: string;
  readonly parent: string | null;
  readonly sibling: string | null;
  readonly detail: string;
};

export type LedgerLine = LedgerHeader | LedgerRun | LedgerAnomaly;

/** `chain-start` is informational: a genesis point is not a defect. Everything
 *  else means the archive and its record of itself disagree. */
export function isDefect(a: LedgerAnomaly): boolean {
  return a.kind !== 'chain-start';
}

export function formatLedger(lines: readonly LedgerLine[]): string {
  return encodeJsonl(lines);
}

export function parseLedger(text: string): LedgerLine[] {
  return decodeJsonl<LedgerLine>(text);
}

export type StoredManifest = {
  readonly key: string;
  readonly manifest: RunManifest;
  /** Recomputed from the bytes actually in the store, never from the parsed
   *  object — that is what makes an edit detectable. */
  readonly sha256: string;
  readonly objects: number;
  readonly bytes: number;
};

/** Reads one day of manifests out of the archive, in runId order. Run ids are
 *  ISO-8601, so lexical order IS chronological order — the same property the
 *  index build relies on. */
export async function readManifests(store: Store, day: Date): Promise<StoredManifest[]> {
  const objects = await store.list(`raw/runs/${datePath(day)}/`);
  const out: StoredManifest[] = [];

  for (const { key } of objects) {
    const bytes = await store.get(key);
    if (bytes === null) continue;
    const manifest = JSON.parse(Buffer.from(bytes).toString('utf8')) as RunManifest;
    out.push({
      key,
      manifest,
      sha256: manifestSha256(bytes),
      objects: 1 + manifest.obsShards.length + manifest.retained.length,
      bytes: manifest.bytesWritten,
    });
  }

  return out.sort((a, b) => (a.manifest.runId < b.manifest.runId ? -1 : 1));
}

function runLine(m: StoredManifest): LedgerRun {
  return {
    k: 'run',
    runId: m.manifest.runId,
    sha256: m.sha256,
    prev: m.manifest.prevManifestSha256 ?? null,
    prevRunId: m.manifest.prevRunId ?? null,
    sinceSeq: m.manifest.sinceSeq,
    lastSeq: m.manifest.lastSeq,
    mode: m.manifest.mode,
    feed: m.manifest.feedBlob.sha256,
    objects: m.objects,
    bytes: m.bytes,
  };
}

/**
 * Turns a day of manifests into ledger lines, anomalies included inline.
 *
 * This NEVER throws on a broken chain. The day the chain breaks must not also be
 * the day the evidence fails to reach git, so a break is recorded as a line and
 * the caller commits it before anything raises an alarm.
 */
export function transcribe(day: string, manifests: readonly StoredManifest[]): LedgerLine[] {
  const byHash = new Map<string, StoredManifest>();
  for (const m of manifests) byHash.set(m.sha256, m);

  const lines: LedgerLine[] = [
    { k: 'ledgerhdr', schema: 1, day, runs: manifests.length },
  ];

  // Which manifests claim which parent, so a fork is visible as two claimants.
  const claimants = new Map<string, StoredManifest[]>();
  for (const m of manifests) {
    const parent = m.manifest.prevManifestSha256;
    if (parent === null || parent === undefined) continue;
    const list = claimants.get(parent) ?? [];
    list.push(m);
    claimants.set(parent, list);
  }

  for (const m of manifests) {
    lines.push(runLine(m));

    const parentHash = m.manifest.prevManifestSha256 ?? null;
    const parentRunId = m.manifest.prevRunId ?? null;

    if (parentHash === null) {
      lines.push({
        k: 'anomaly', kind: 'chain-start', runId: m.manifest.runId,
        parent: null, sibling: null,
        detail: 'no parent recorded; genesis, a pre-chain manifest, or a run after recover-cursor',
      });
      continue;
    }

    const siblings = (claimants.get(parentHash) ?? []).filter(
      (s) => s.manifest.runId !== m.manifest.runId,
    );
    for (const sibling of siblings) {
      // A run killed between COMMIT C and COMMIT D leaves the cursor pointing at
      // the parent it already used, so the next run reuses it. That produces two
      // siblings whose seq windows touch, because the second re-drained from where
      // the first started. Disjoint windows with a gap between them cannot come
      // from a crash.
      const contiguous =
        m.manifest.sinceSeq <= sibling.manifest.lastSeq &&
        sibling.manifest.sinceSeq <= m.manifest.lastSeq;
      lines.push({
        k: 'anomaly',
        kind: contiguous ? 'fork' : 'fork-suspicious',
        runId: m.manifest.runId,
        parent: parentHash,
        sibling: sibling.manifest.runId,
        detail: contiguous
          ? `seq ranges overlap (${m.manifest.sinceSeq}-${m.manifest.lastSeq} vs ` +
            `${sibling.manifest.sinceSeq}-${sibling.manifest.lastSeq}); consistent with a run ` +
            `that died between COMMIT C and COMMIT D`
          : `seq ranges are disjoint (${m.manifest.sinceSeq}-${m.manifest.lastSeq} vs ` +
            `${sibling.manifest.sinceSeq}-${sibling.manifest.lastSeq}); no crash produces this`,
      });
    }

    // Only resolvable within the day we read. A parent in yesterday's file is
    // checked by verifyLedger across the committed ledger, not here.
    const parentInDay = manifests.find((x) => x.manifest.runId === parentRunId);
    if (parentInDay === undefined) continue;

    if (!byHash.has(parentHash)) {
      lines.push({
        k: 'anomaly', kind: 'hash-mismatch', runId: m.manifest.runId,
        parent: parentHash, sibling: parentRunId,
        // Name the CHILD as the inconsistent record: the child's claim is what no
        // longer matches, and accusing the parent of "forking" would point the
        // investigation at the wrong file.
        detail: `parent ${parentRunId} is present but rehashes to ${parentInDay.sha256}; ` +
          `the parent's bytes were edited after this run recorded them`,
      });
    }
  }

  return lines;
}

export type ChainReport = {
  readonly runs: number;
  readonly anomalies: readonly LedgerAnomaly[];
  readonly defects: number;
};

/**
 * Verifies a chain across ledger lines — from the committed files alone, with no
 * bucket access. This is the check anyone with a clone of the repo can run.
 */
export function verifyChain(lines: readonly LedgerLine[]): ChainReport {
  const runs = lines.filter((l): l is LedgerRun => l.k === 'run');
  const anomalies: LedgerAnomaly[] = lines.filter((l): l is LedgerAnomaly => l.k === 'anomaly');

  const known = new Set(runs.map((r) => r.sha256));
  const byRunId = new Set(runs.map((r) => r.runId));

  // Which days this verification actually covers. A parent outside them is not
  // evidence of anything — it simply predates the files we were handed. Inside
  // them, an absent parent is a deletion, and there is no innocent reading.
  //
  // This distinction is why run ids are ISO-8601 timestamps: the parent's day is
  // derivable from its id alone, with no extra bookkeeping.
  const days = new Set(
    lines.filter((l): l is LedgerHeader => l.k === 'ledgerhdr').map((l) => l.day),
  );

  for (const run of runs) {
    if (run.prev === null || run.prevRunId === null) continue;
    if (known.has(run.prev)) continue;
    if (!days.has(run.prevRunId.slice(0, 10))) continue;

    anomalies.push(
      byRunId.has(run.prevRunId)
        ? {
            k: 'anomaly', kind: 'hash-mismatch', runId: run.runId,
            parent: run.prev, sibling: run.prevRunId,
            detail: `parent ${run.prevRunId} is in the ledger but under a different hash; ` +
              `its bytes changed after this run recorded them`,
          }
        : {
            k: 'anomaly', kind: 'missing-parent', runId: run.runId,
            parent: run.prev, sibling: run.prevRunId,
            detail: `parent ${run.prevRunId} is absent from the ledger for the day it belongs ` +
              `to; a manifest was deleted`,
          },
    );
  }

  const unique = new Map<string, LedgerAnomaly>();
  for (const a of anomalies) unique.set(`${a.kind}:${a.runId}:${a.sibling ?? ''}`, a);
  const all = [...unique.values()];

  return { runs: runs.length, anomalies: all, defects: all.filter(isDefect).length };
}

/** Re-derives each manifest's canonical bytes and compares against the store.
 *  Guards the one failure that would make the whole feature quietly lie: the
 *  writer and the verifier disagreeing about what "canonical" means. */
export function assertCanonical(m: StoredManifest, bytes: Uint8Array): void {
  if (Buffer.compare(canonicalManifestBytes(m.manifest), Buffer.from(bytes)) !== 0) {
    throw new Error(
      `manifest ${m.key} does not round-trip through canonicalManifestBytes. The writer and ` +
        `the ledger verifier disagree about canonical form, which would make every hash after ` +
        `this point meaningless.`,
    );
  }
}

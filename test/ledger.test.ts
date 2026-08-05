import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import * as cursorMod from '../src/cursor.ts';
import type { DrainResult, FeedRow } from '../src/feed.ts';
import {
  assertCanonical, formatLedger, isDefect, type LedgerAnomaly, type LedgerRun,
  parseLedger, readManifests, transcribe, verifyChain,
} from '../src/ledger.ts';
import { canonicalManifestBytes, type RunManifest } from '../src/manifest.ts';
import { setSaltForTesting } from '../src/pii.ts';
import type { PackumentResult } from '../src/registry.ts';
import { record } from '../src/run.ts';
import { FsStore } from '../src/store.fs.ts';
import { packument } from './fixtures.ts';

setSaltForTesting('test-salt-0123456789abcdef');

const HEAD = 1_000_000;
const DAY = '2026-08-03';
const newStore = () => new FsStore(mkdtempSync(join(tmpdir(), 'tape-ledger-')));

function feedRow(name: string, seq: number, rev = '1-abc'): FeedRow {
  return { seq, id: name, changes: [{ rev }] };
}

function drained(rows: FeedRow[], sinceSeq: number, lastSeq: number): DrainResult {
  return { rows, sinceSeq, lastSeq, pages: 1, atHead: true };
}

function serve(): () => Promise<PackumentResult> {
  const doc = packument('left-pad');
  const raw = Buffer.from(JSON.stringify(doc), 'utf8');
  return async () => ({
    outcome: 'ok', status: 200, doc, raw, etag: null, bytes: raw.length, error: null,
  });
}

const opts = (store: FsStore, rows: FeedRow[], since: number, last: number, at: string) => ({
  store,
  now: new Date(`${DAY}T${at}Z`),
  headSeqFn: async () => HEAD,
  drainFn: async () => drained(rows, since, last),
  fetchPackumentFn: serve(),
});

/** Two consecutive runs, chained the way production chains them. */
async function twoRuns(store: FsStore) {
  await cursorMod.write(store, cursorMod.initial(100, new Date()));
  await record(opts(store, [feedRow('left-pad', 101)], 100, 101, '12:00:00'));
  await record(opts(store, [feedRow('lodash', 102)], 101, 102, '12:15:00'));
  return readManifests(store, new Date(`${DAY}T00:00:00Z`));
}

async function overwriteManifest(
  store: FsStore, key: string, mutate: (m: RunManifest) => RunManifest,
): Promise<void> {
  const bytes = (await store.get(key))!;
  const parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) as RunManifest;
  await store.put(key, canonicalManifestBytes(mutate(parsed)));
}

const anomalies = (lines: readonly unknown[]) =>
  lines.filter((l): l is LedgerAnomaly => (l as LedgerAnomaly).k === 'anomaly');

describe('the hash chain', () => {
  it('links each manifest to the one before it', async () => {
    const store = newStore();
    const manifests = await twoRuns(store);
    assert.equal(manifests.length, 2);

    const [first, second] = manifests;
    assert.equal(first!.manifest.prevRunId, null, 'the first run is a genesis point');
    assert.equal(second!.manifest.prevRunId, first!.manifest.runId);
    assert.equal(second!.manifest.prevManifestSha256, first!.sha256,
      'the child names the parent by the hash of its canonical bytes');
  });

  it('round-trips through canonicalManifestBytes', async () => {
    // The single most likely way this feature starts lying is the writer and the
    // verifier drifting apart on what "canonical" means. They share one function
    // precisely so this test can pin it against the bytes actually in the store.
    const store = newStore();
    for (const m of await twoRuns(store)) {
      const bytes = await store.get(m.key);
      assert.ok(bytes);
      assert.doesNotThrow(() => assertCanonical(m, bytes));
    }
  });

  it('reads a manifest written before `retained` existed at all', async () => {
    // This crashed the nightly build job on 2026-08-04 and took the day's digest
    // and ledger upload with it: `manifest.retained.length` on a manifest written
    // before f59ae1d, where the field does not exist. TypeError inside
    // readManifests — upstream of transcribe(), so the "ledger mode always exits
    // zero" promise never got a chance to apply.
    //
    // Those manifests are in the bucket permanently. An append-only archive keeps
    // every shape it has ever written, so a reader must default, not assume.
    const store = newStore();
    const pre = {
      runId: '2026-08-03T01-04-00Z', schema: 1,
      startedAt: 'a', completedAt: 'b', sinceSeq: 1, lastSeq: 2, mode: 'steady',
      feedBlob: { key: 'k', sha256: 's', rows: 1 },
      obsShards: [], queued: 0, fetched: 0, deferred: 0, bytesWritten: 1,
      // No `retained`, no `prevRunId`, no `prevManifestSha256`, no `budget`.
    };
    await store.put(
      `raw/runs/2026/08/03/${pre.runId}.json`,
      Buffer.from(`${JSON.stringify(pre, null, 2)}\n`, 'utf8'),
    );

    const manifests = await readManifests(store, new Date(`${DAY}T00:00:00Z`));
    assert.equal(manifests.length, 1);
    assert.equal(manifests[0]!.objects, 1, 'the feed blob, and nothing it cannot see');

    // And it transcribes and verifies as a chain start rather than a defect.
    const report = verifyChain(transcribe(DAY, manifests));
    assert.equal(report.defects, 0);
  });

  it('accepts a manifest written before the chain existed', async () => {
    // Every manifest already in the archive has no prev fields at all. Those are
    // chain starts, not breaks — reading them as breaks would mean the feature
    // began by accusing its own history.
    const store = newStore();
    const manifests = await twoRuns(store);
    const key = manifests[0]!.key;
    await overwriteManifest(store, key, (m) => {
      const stripped: Record<string, unknown> = { ...m };
      delete stripped['prevRunId'];
      delete stripped['prevManifestSha256'];
      return stripped as unknown as RunManifest;
    });

    const reread = await readManifests(store, new Date(`${DAY}T00:00:00Z`));
    const lines = transcribe(DAY, reread);
    const start = anomalies(lines).find((a) => a.runId === reread[0]!.manifest.runId);
    assert.equal(start?.kind, 'chain-start');
    assert.equal(isDefect(start!), false, 'a chain start is informational, not a defect');
  });
});

describe('what the chain detects', () => {
  it('reports a tampered parent as hash-mismatch, naming the child', async () => {
    const store = newStore();
    const manifests = await twoRuns(store);

    // Edit the FIRST manifest after the second already recorded its hash.
    await overwriteManifest(store, manifests[0]!.key, (m) => ({ ...m, fetched: 999 }));

    const lines = transcribe(DAY, await readManifests(store, new Date(`${DAY}T00:00:00Z`)));
    const defect = anomalies(lines).filter(isDefect);
    assert.equal(defect.length, 1);
    assert.equal(defect[0]!.kind, 'hash-mismatch');
    assert.equal(defect[0]!.runId, manifests[1]!.manifest.runId,
      'the CHILD is the inconsistent record — the parent is merely the evidence');
  });

  it('reports a deleted manifest as missing-parent, not as tampering', async () => {
    // A deletion and an edit need different responses, so they must not collapse
    // into one anomaly kind.
    const store = newStore();
    const manifests = await twoRuns(store);
    await store.delete(manifests[0]!.key);

    const lines = transcribe(DAY, await readManifests(store, new Date(`${DAY}T00:00:00Z`)));
    const report = verifyChain(lines);
    const kinds = report.anomalies.filter(isDefect).map((a) => a.kind);
    assert.deepEqual(kinds, ['missing-parent']);
  });

  it('reports a run killed between COMMIT C and COMMIT D as a fork, not tampering', async () => {
    // This is the known cost of carrying the parent in the cursor, and it is a
    // routine consequence of a killed run — exactly the same class as the
    // duplicates every other failure window in this design produces. Calling it
    // tampering would train the operator to ignore the one alarm that matters.
    const store = newStore();
    await cursorMod.write(store, cursorMod.initial(100, new Date()));
    await record(opts(store, [feedRow('left-pad', 101)], 100, 101, '12:00:00'));

    const afterFirst = (await cursorMod.read(store))!;
    await record(opts(store, [feedRow('lodash', 102)], 101, 102, '12:15:00'));

    // Rewind the cursor's chain pointer to what it was before the second run —
    // exactly the state a run that died after COMMIT C would have left behind.
    const now = (await cursorMod.read(store))!;
    await cursorMod.write(store, {
      ...now,
      lastSeq: 102,
      pendingFeedKey: null,
      lastManifestRunId: afterFirst.lastManifestRunId,
      lastManifestSha256: afterFirst.lastManifestSha256,
    });
    await record(opts(store, [feedRow('chalk', 103)], 102, 103, '12:30:00'));

    const lines = transcribe(DAY, await readManifests(store, new Date(`${DAY}T00:00:00Z`)));
    const forks = anomalies(lines).filter((a) => a.kind === 'fork' || a.kind === 'fork-suspicious');
    assert.ok(forks.length >= 1, 'the two siblings claiming one parent must be reported');
    assert.equal(forks[0]!.kind, 'fork', 'contiguous seq ranges read as a dead run');
    assert.match(forks[0]!.detail, /COMMIT C and COMMIT D/);
    assert.ok(forks.every((f) => f.sibling !== null), 'both siblings are named');
  });
});

describe('the ledger file', () => {
  it('is deterministic, so a re-run is a no-op commit', async () => {
    const store = newStore();
    const manifests = await twoRuns(store);
    assert.equal(
      formatLedger(transcribe(DAY, manifests)),
      formatLedger(transcribe(DAY, manifests)),
    );
  });

  it('records anomalies as lines rather than throwing', async () => {
    // The day the chain breaks must not also be the day the evidence fails to
    // reach git. Transcription always produces a file; the alarm comes after.
    const store = newStore();
    const manifests = await twoRuns(store);
    await overwriteManifest(store, manifests[0]!.key, (m) => ({ ...m, fetched: 999 }));

    const reread = await readManifests(store, new Date(`${DAY}T00:00:00Z`));
    const lines = transcribe(DAY, reread);
    assert.ok(anomalies(lines).some(isDefect), 'the defect is in the file');
    assert.ok(lines.filter((l) => l.k === 'run').length === 2, 'and so is every run');
  });

  it('verifies from the committed lines alone, with no archive access', async () => {
    // The public claim: anyone with a clone can check the chain. No store here.
    const store = newStore();
    const text = formatLedger(transcribe(DAY, await twoRuns(store)));

    const report = verifyChain(parseLedger(text));
    assert.equal(report.runs, 2);
    assert.equal(report.defects, 0);

    // Rewrite one run's hash in the committed text — the parent link no longer
    // resolves, which is precisely what a retroactive edit looks like.
    const lines = parseLedger(text);
    const first = lines.find((l): l is LedgerRun => l.k === 'run')!;
    const forged = lines.map((l) =>
      l.k === 'run' && l.runId === first.runId ? { ...l, sha256: 'f'.repeat(64) } : l,
    );
    assert.ok(verifyChain(forged).defects > 0, 'an edited ledger must not verify');
  });
});

/**
 * One recording run. The file to open first at 2am.
 *
 * The ordering below is the whole safety argument, so it is worth stating plainly:
 *
 *   drain the feed  →  COMMIT A (feed bytes durable)  →  COMMIT B (cursor advances)
 *                   →  fetch packuments  →  COMMIT C (deferred + manifest)
 *
 * The cursor guards the FEED, not the fetch queue. The feed is queryable forward
 * only and has no substitute anywhere on the internet; packuments are re-fetchable
 * forever from the rows we already stored. So the irreplaceable thing is made
 * durable first and the replaceable thing gets a retry queue.
 *
 * Every failure window in that ordering produces duplicates. None produces loss.
 */

import { gzipSync } from 'node:zlib';

import {
  BACKLOG_THRESHOLD,
  FETCH_CUT_MS,
  HARD_DEADLINE_MS,
  MAX_RETAINED_PACKUMENT_BYTES,
  REGISTRY_CONCURRENCY_BACKLOG,
  REGISTRY_CONCURRENCY_STEADY,
  REGISTRY_RPS_BACKLOG,
  REGISTRY_RPS_STEADY,
  TRIAGE_THRESHOLD,
  USAGE_ANCHOR_STALE_MS,
} from './config.ts';
import * as budgetMod from './budget.ts';
import * as cursorMod from './cursor.ts';
import type { Cursor } from './cursor.ts';
import { dedupeByNameKeepingNewest, drain, headSeq, revOf, writeFeedBlob } from './feed.ts';
import type { DrainResult, FeedRow } from './feed.ts';
import { Limiter } from './http.ts';
import { decodeJsonl, putJsonl, sha256Hex, ShardWriter } from './jsonl.ts';
import { log } from './log.ts';
import { canonicalManifestBytes, manifestSha256, type RunManifest } from './manifest.ts';
import { buildObservation, gap, shouldRetainPackument } from './observation.ts';
import type { Row } from './observation.ts';
import { assertNoPersonalAddresses, assertNoPII, hashEmail, PIILeakError } from './pii.ts';
import { redactPackument } from './redact.ts';
import { fetchPackument } from './registry.ts';
import type { PackumentResult } from './registry.ts';
import { keys, runIdFrom, type Store } from './store.ts';
import { gunzipSync } from 'node:zlib';

/**
 * A retained packument, as named in the run manifest.
 *
 * These used to appear in the manifest nowhere at all, which made README's claim
 * that a manifest is "sha256 of everything written" false, and left a hole in the
 * ledger: a retained packument could be replaced in the bucket with every
 * manifest still verifying. `written: false` means putIfAbsent found the key
 * already there — recorded anyway, so the hash is checkable either way, and so
 * the byte accounting stays honest.
 */
export type RetainedPackument = {
  readonly key: string;
  /** sha256 of the UNCOMPRESSED redacted text — see jsonl.ts for why not the gzip. */
  readonly sha256: string;
  readonly gzBytes: number;
  readonly written: boolean;
};

export type RunSummary = {
  readonly runId: string;
  readonly sinceSeq: number;
  readonly lastSeq: number;
  readonly feedRows: number;
  readonly distinctPackages: number;
  readonly fetched: number;
  readonly deferred: number;
  readonly flagged: number;
  readonly unpublishes: number;
  readonly versionUnpublishes: number;
  readonly packagesWithYanks: number;
  readonly piiRefused: number;
  /** Everything written, manifest included — the figure that matches the bill. */
  readonly bytesWritten: number;
  readonly retained: number;
  readonly retentionSkipped: number;
  readonly mode: 'steady' | 'backlog' | 'triage';
  /** Why the run triaged: a deep queue, or an exhausted storage budget. `mode` is
   *  the behaviour; this is the cause, and they must not be conflated. */
  readonly triageReason: 'queue' | 'budget' | null;
  readonly storage: budgetMod.Estimate;
};

export type RunOptions = {
  readonly store: Store;
  readonly now?: Date;
  /** Wall-clock budget for the fetch phase. */
  readonly fetchCutMs?: number;
  /** Test/dev cap on how many packuments to fetch. */
  readonly maxFetch?: number;
  /** Overrides the storage ceiling, so a budget tier is reachable in a test
   *  without filling a real bucket. */
  readonly storageCeilingBytes?: number;

  /**
   * Seams for testing the commit ordering without a network.
   *
   * The ordering in this file is the project's entire safety argument and it was
   * asserted only by prose until these existed. Everything defaults to the real
   * implementation, so production behaviour is unchanged.
   */
  readonly headSeqFn?: () => Promise<number>;
  readonly drainFn?: (sinceSeq: number) => Promise<DrainResult>;
  readonly fetchPackumentFn?: (name: string, limiter: Limiter) => Promise<PackumentResult>;
};

async function loadDeferred(store: Store): Promise<FeedRow[]> {
  const bytes = await store.get(keys.deferred());
  if (bytes === null) return [];
  return decodeJsonl<FeedRow>(gunzipSync(bytes).toString('utf8'));
}

export async function record(opts: RunOptions): Promise<RunSummary> {
  const store = opts.store;
  const now = opts.now ?? new Date();
  const runId = runIdFrom(now);
  const startedAt = Date.now();
  const fetchCut = startedAt + (opts.fetchCutMs ?? FETCH_CUT_MS);
  // The workflow's timeout-minutes SIGKILLs the job, which would abandon the
  // deferred queue and the manifest. This budget is deliberately tighter so the
  // run finishes its own commits and exits cleanly instead.
  const hardDeadline = startedAt + HARD_DEADLINE_MS;
  let bytesWritten = 0;

  // ── STEP 0: read state, and sanity-check it against the live head ──────────
  const headSeqFn = opts.headSeqFn ?? headSeq;
  const drainFn = opts.drainFn ?? drain;
  const fetchFn = opts.fetchPackumentFn ?? fetchPackument;

  const head = await headSeqFn();
  let cursor: Cursor = (await cursorMod.read(store)) ?? cursorMod.initial(head, now);
  cursorMod.assertSane(cursor, head);

  const deferredRows = await loadDeferred(store);

  // Recover from a previous run that died after the cursor advanced but before it
  // finished fetching. The feed rows are durable — that ordering is the whole
  // point — so the names are recoverable exactly.
  const recovered: FeedRow[] = [];
  if (cursor.pendingFeedKey !== null) {
    const bytes = await store.get(cursor.pendingFeedKey);
    if (bytes !== null) {
      for (const r of decodeJsonl<FeedRow & { k?: string }>(gunzipSync(bytes).toString('utf8'))) {
        if (r.k !== 'feedhdr' && typeof r.id === 'string') recovered.push(r);
      }
      log.warn('recovering an unfinished run from its feed blob', {
        key: cursor.pendingFeedKey, rows: recovered.length,
      });
    } else {
      log.error('pending feed blob is missing from the archive', { key: cursor.pendingFeedKey });
    }
  }
  log.info('run start', {
    runId, lastSeq: cursor.lastSeq, head, behind: head - cursor.lastSeq,
    deferred: deferredRows.length,
  });

  // ── STEP 1: drain the feed to exhaustion ──────────────────────────────────
  // Deliberately unbounded. A three-day backlog is ~63,000 rows: seven requests,
  // under a minute. Being behind on the feed is the only unrecoverable state.
  const drained = await drainFn(cursor.lastSeq);
  log.info('feed drained', {
    rows: drained.rows.length, pages: drained.pages,
    sinceSeq: drained.sinceSeq, lastSeq: drained.lastSeq, atHead: drained.atHead,
  });

  // ── STEP 2 — COMMIT A: the irreplaceable bytes become durable ─────────────
  const receipt = await writeFeedBlob(store, drained, now);
  // The REAL stored size. This was `receipt.rows * 100` — not a wild guess, but a
  // measurement of the wrong quantity: ~100 bytes is a feed row RAW, and gzipped
  // it is roughly a third of that, so stored bytes were over-counted ~3x. It was
  // also the only write in the run whose size was estimated rather than measured,
  // which is precisely why a spend cap could not be built on this number.
  bytesWritten += receipt.gzBytes;
  log.info('COMMIT A feed blob', { key: receipt.key, rows: receipt.rows });

  // ── STEP 3 — COMMIT B: only now may the cursor move ───────────────────────
  // `advance` cannot be called without the receipt above. That is a type-level
  // guarantee, not a convention — see feed.ts.
  cursor = cursorMod.advance(cursor, receipt, now);
  await cursorMod.write(store, cursor);
  log.info('COMMIT B cursor advanced', { lastSeq: cursor.lastSeq });

  // ── STEP 3b: how much of itself this run is allowed to be ─────────────────
  //
  // Textually AFTER commits A and B, and that is not an accident: `tierFor` takes
  // a FeedReceipt, which only writeFeedBlob can mint, so the budget cannot be
  // evaluated before the feed is durable. The cap physically cannot refuse the
  // one write that would lose data permanently.
  //
  // A missing or unreadable anchor yields the drift only, which UNDER-estimates —
  // and under-estimating is the safe direction for a cap, because it fails toward
  // recording. A stale anchor means the cap has quietly stopped working; that
  // warns and never fails, since the tape outranks its own accounting.
  const usage = await budgetMod.read(store).catch(() => null);
  if (usage !== null && usage.measuredAt !== cursor.usageAnchorAt) {
    cursor = { ...cursor, usageAnchorAt: usage.measuredAt, bytesSinceUsageAnchor: 0 };
  }
  const ceiling = opts.storageCeilingBytes ?? budgetMod.ceilingBytes(process.env);
  const storedEstimate = (usage?.storedBytes ?? 0) + cursor.bytesSinceUsageAnchor;
  const stale = usage === null
    || now.getTime() - Date.parse(usage.measuredAt) > USAGE_ANCHOR_STALE_MS;
  const tier = budgetMod.tierFor(receipt, storedEstimate, ceiling);
  const estimate: budgetMod.Estimate = {
    storedBytes: storedEstimate, ceiling, tier, anchored: usage !== null, stale,
  };
  if (tier !== 'normal') {
    log.warn('storage budget: running degraded', { tier, storage: budgetMod.describe(estimate) });
  } else if (stale) {
    log.warn('storage budget: the anchor is missing or stale, so the cap is not enforcing',
      { storage: budgetMod.describe(estimate) });
  }

  // ── STEP 4: fetch packuments ──────────────────────────────────────────────
  // A newer rev supersedes an older queue entry: its `time` map is a superset, so
  // one fetch covers both. This is what collapses a multi-day backlog.
  const queue = dedupeByNameKeepingNewest([...recovered, ...deferredRows, ...drained.rows]);
  // `mode` stays the BEHAVIOUR and triageReason records the CAUSE. A fourth mode
  // value would conflate them and would run the identical code path anyway.
  const triageReason: RunSummary['triageReason'] =
    tier === 'hard' ? 'budget' : queue.length > TRIAGE_THRESHOLD ? 'queue' : null;
  const mode: RunSummary['mode'] =
    triageReason !== null ? 'triage'
    : queue.length > BACKLOG_THRESHOLD ? 'backlog'
    : 'steady';

  const limiter = mode === 'steady'
    ? new Limiter(REGISTRY_RPS_STEADY, REGISTRY_CONCURRENCY_STEADY)
    : new Limiter(REGISTRY_RPS_BACKLOG, REGISTRY_CONCURRENCY_BACKLOG);

  const shards = new ShardWriter(store, (part) => keys.obs(now, runId, part), assertNoPII);
  const budget = opts.maxFetch ?? Number.POSITIVE_INFINITY;

  let fetched = 0;
  let flagged = 0;
  let unpublishes = 0;
  let versionUnpublishes = 0;
  let packagesWithYanks = 0;
  let piiRefused = 0;
  let retentionSkipped = 0;
  const remaining: FeedRow[] = [];
  const retained: RetainedPackument[] = [];

  if (recovered.length > 0) {
    await shards.add(gap(runId, 'recovered', now, { detail: `rows=${recovered.length}` }));
  }

  if (mode === 'triage') {
    // Anti-wedge: enrichment must never starve capture. The names are safe in
    // raw/feed either way, so this only defers work — it never loses it. The
    // budget reuses this exact path rather than inventing a new one, because the
    // trade it accepts is the trade TRIAGE_THRESHOLD already accepts.
    log.warn(
      triageReason === 'budget'
        ? 'TRIAGE: storage budget exhausted, capturing feed only'
        : 'TRIAGE: queue too deep, capturing feed only',
      { queue: queue.length, reason: triageReason },
    );
    // Always written, at every tier: the record of the run's own degradation is
    // never itself a casualty of the degradation.
    await shards.add(gap(runId, 'triage', now, {
      detail: `queue=${queue.length};reason=${triageReason}` +
        (triageReason === 'budget' ? `;stored=${storedEstimate}` : ''),
    }));
    remaining.push(...queue);
  } else {
    for (const row of queue) {
      if (fetched >= budget || Date.now() >= fetchCut) {
        remaining.push(row);
        continue;
      }
      if (Date.now() >= hardDeadline) {
        // Should be unreachable — fetchCut fires first — but if a single fetch
        // stalls past it, stop spending time we need for COMMIT C.
        log.warn('hard deadline reached; stopping fetch phase', { fetched, queued: queue.length });
        remaining.push(row);
        break;
      }

      const result = await fetchFn(row.id, limiter);
      fetched++;

      let packumentKey: string | null = null;
      const draft = buildObservation({ runId, row, result, now, packumentKey: null });

      // MEASURED on a live sample: this retains ~11% of changed packages at a mean
      // of 3.2 KB gzipped. Retaining every packument would be 3.54 GB/day. Under a
      // soft budget the list narrows to the packuments that cannot be re-fetched.
      const wanted = shouldRetainPackument(draft, tier === 'soft' ? 'soft' : 'normal');
      if (result.raw !== null && !wanted && shouldRetainPackument(draft)) retentionSkipped++;
      if (result.raw !== null && wanted && result.doc !== null) {
        const rev = revOf(row);
        if (rev !== null) {
          // Retained packuments are stored REDACTED, not verbatim. Storing them
          // raw was the design as first written and it put ~229 real maintainer
          // addresses into the archive on a single test run — the exact bulk
          // contact corpus the policy exists to prevent. Structure and every
          // non-PII field survive; addresses become the same salted hashes the
          // observation rows carry, so they still join across time.
          const text = JSON.stringify(redactPackument(result.doc, hashEmail));

          // The gate is right to refuse and wrong to stop everything. A README
          // that defeats redaction costs forensic depth on one package; aborting
          // costs an entire hour of the registry, and the tape outranks any
          // single package.
          let refusal: string | null = null;
          try {
            assertNoPersonalAddresses(text, `packument:${row.id}`);
          } catch (err) {
            if (!(err instanceof PIILeakError)) throw err;
            refusal = err.rule;
          }

          const gz = refusal === null ? gzipSync(Buffer.from(text, 'utf8'), { level: 9 }) : null;

          if (refusal !== null) {
            log.warn('PII gate refused a packument', { name: row.id, rule: refusal });
            await shards.add(gap(runId, 'pii_refused', now, {
              name: row.id, seq: row.seq, rev, detail: `packument:${refusal}`,
            }));
            piiRefused++;
          } else if (gz !== null && gz.length > MAX_RETAINED_PACKUMENT_BYTES) {
            // Skipped, not silently dropped: the decision becomes a queryable row.
            await shards.add(gap(runId, 'too_large', now, {
              name: row.id, seq: row.seq, rev, detail: `packument_gz=${gz.length}`,
            }));
          } else if (gz !== null) {
            packumentKey = keys.packument(row.id, rev);
            // Keyed by (name, rev), so a re-fetch after a crash writes nothing.
            const { written } = await store.putIfAbsent(packumentKey, gz);
            if (written) bytesWritten += gz.length;
            // Named and hashed in the manifest even when nothing was written.
            // `redactPackument` is deterministic for a given (doc, salt), so if
            // two runs a month apart hash the same (name, rev) differently, npm
            // mutated a packument under a stable _rev — which is itself a
            // finding. Hashing the UNCOMPRESSED text, for the reason in jsonl.ts.
            retained.push({
              key: packumentKey,
              sha256: sha256Hex(text),
              gzBytes: gz.length,
              written,
            });
          }
        }
      }

      const obs = packumentKey === null
        ? draft
        : buildObservation({ runId, row, result, now, packumentKey });

      // Gate each row on its own before it joins a shard. The guard also runs at
      // flush time over the whole serialized shard, and one poisoned row would
      // take 250 good ones down with it.
      try {
        assertNoPII(JSON.stringify(obs), `obs:${row.id}`);
      } catch (err) {
        if (!(err instanceof PIILeakError)) throw err;
        // The gate is right to refuse and wrong to stop everything. Record the
        // refusal as a first-class row so it is queryable, and keep rolling.
        log.warn('PII gate refused an observation row', { name: row.id, rule: err.rule });
        await shards.add(gap(runId, 'pii_refused', now, {
          name: row.id, seq: row.seq, rev: revOf(row), detail: `row:${err.rule}`,
        }));
        piiRefused++;
        continue;
      }

      await shards.add(obs satisfies Row);
      if (obs.flags.length > 0) flagged++;
      if (obs.tombstone) unpublishes++;
      // The true total, not the truncated list — a churning package must not be
      // able to understate itself just because its row was capped. Reported
      // alongside the package count, because a single automated test package can
      // carry 17,000 yanks and would otherwise read as a registry-wide event.
      versionUnpublishes += obs.missingCount;
      if (obs.missingCount > 0) packagesWithYanks++;

      if (result.outcome === 'error' || result.outcome === 'too_large') {
        await shards.add(gap(runId, result.outcome === 'too_large' ? 'too_large' : 'fetch_failed',
          now, { name: row.id, seq: row.seq, rev: revOf(row), status: result.status,
                 detail: result.error }));
        remaining.push(row); // retry next run
      }
    }
  }
  // ── STEP 5 — COMMIT C: deferred queue FIRST, then the manifest ────────────
  // Always rewritten, even when empty — otherwise the entries this run consumed
  // would linger and be reprocessed forever. Overwriting is what removes the need
  // for a delete-capable credential.
  const deduped = dedupeByNameKeepingNewest(remaining);
  if (deduped.length > 0) {
    await shards.add(gap(runId, 'deferred', now, { detail: `count=${deduped.length}` }));
    log.info('deferred', { count: deduped.length });
  }

  // One row per degraded run, not one per skipped packument — 2,300 rows a day
  // would be noise. This is what makes "which days did the tape run degraded?" a
  // query against the index rather than an archaeology exercise in the logs.
  if (tier === 'soft') {
    await shards.add(gap(runId, 'budget', now, {
      detail: `tier=soft;retention_skipped=${retentionSkipped};stored=${storedEstimate};` +
        `ceiling=${ceiling}`,
    }));
  }

  // MUST be the last shards.add() in the run. This gap row used to be added AFTER
  // this flush, and ShardWriter.add only auto-flushes at SHARD_MAX_ROWS or
  // SHARD_MAX_BYTES — one row trips neither — so every deferred gap row the tape
  // ever wrote was buffered and discarded, and was missing from obsShards too.
  await shards.flush();
  for (const s of shards.shards) bytesWritten += s.gzBytes;

  const written = await putJsonl(store, keys.deferred(), deduped, assertNoPII);
  bytesWritten += written.gzBytes;

  const manifest: RunManifest = {
    runId,
    schema: 1,
    // Read from the cursor, not derived from the archive — see cursor.ts for why
    // the resulting fork window is the right way to be wrong.
    prevRunId: cursor.lastManifestRunId,
    prevManifestSha256: cursor.lastManifestSha256,
    startedAt: now.toISOString(),
    completedAt: new Date().toISOString(),
    sinceSeq: receipt.sinceSeq,
    lastSeq: receipt.lastSeq,
    mode,
    feedBlob: {
      key: receipt.key, sha256: receipt.sha256, rows: receipt.rows,
      rawBytes: receipt.rawBytes, gzBytes: receipt.gzBytes,
    },
    obsShards: shards.shards,
    retained,
    queued: queue.length,
    fetched,
    deferred: remaining.length,
    budget: { tier, storedBytes: storedEstimate, ceiling, triageReason },
    // Everything above EXCEPT this manifest — a file cannot state its own size.
    // The cursor's counter is the one that includes it, so the number an operator
    // watches for billing is the cursor's, not this one.
    bytesWritten,
  };
  const manifestBytes = canonicalManifestBytes(manifest);
  await store.put(keys.manifest(now, runId), manifestBytes);

  // ── STEP 6 — COMMIT D: record completion ──────────────────────────────────
  // The manifest's own bytes count here and nowhere else. `manifest.bytesWritten`
  // cannot include them, so the cursor is the only place the total is complete —
  // and the total is what bills.
  const bytesTotal = bytesWritten + manifestBytes.length;
  cursor = cursorMod.withRunComplete(
    cursor, runId, new Date(), bytesTotal, manifestSha256(manifestBytes),
  );
  await cursorMod.write(store, cursor);

  // One aggregate line about transient store failures, rather than one per hiccup.
  if ('logStats' in store && typeof store.logStats === 'function') store.logStats();

  const summary: RunSummary = {
    runId,
    sinceSeq: receipt.sinceSeq,
    lastSeq: receipt.lastSeq,
    feedRows: receipt.rows,
    distinctPackages: queue.length,
    fetched,
    deferred: remaining.length,
    flagged,
    unpublishes,
    versionUnpublishes,
    packagesWithYanks,
    piiRefused,
    // The complete figure, manifest included, so the number an operator watches
    // in the step summary is the one that matches the bill.
    bytesWritten: bytesTotal,
    retained: retained.length,
    retentionSkipped,
    mode,
    triageReason,
    storage: { ...estimate, storedBytes: storedEstimate + bytesTotal },
  };
  log.info('run complete', {
    ...summary,
    storage: budgetMod.describe(summary.storage),
    elapsedMs: Date.now() - startedAt,
  });
  return summary;
}

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
} from './config.ts';
import * as cursorMod from './cursor.ts';
import type { Cursor } from './cursor.ts';
import { dedupeByNameKeepingNewest, drain, headSeq, revOf, writeFeedBlob } from './feed.ts';
import type { FeedRow } from './feed.ts';
import { Limiter } from './http.ts';
import { decodeJsonl, putJsonl, ShardWriter } from './jsonl.ts';
import { log } from './log.ts';
import { buildObservation, gap, shouldRetainPackument } from './observation.ts';
import type { Row } from './observation.ts';
import { assertNoPersonalAddresses, assertNoPII, hashEmail, PIILeakError } from './pii.ts';
import { redactPackument } from './redact.ts';
import { fetchPackument } from './registry.ts';
import { keys, runIdFrom, type Store } from './store.ts';
import { gunzipSync } from 'node:zlib';

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
  readonly bytesWritten: number;
  readonly mode: 'steady' | 'backlog' | 'triage';
};

export type RunOptions = {
  readonly store: Store;
  readonly now?: Date;
  /** Wall-clock budget for the fetch phase. */
  readonly fetchCutMs?: number;
  /** Test/dev cap on how many packuments to fetch. */
  readonly maxFetch?: number;
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
  const head = await headSeq();
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
  const drained = await drain(cursor.lastSeq);
  log.info('feed drained', {
    rows: drained.rows.length, pages: drained.pages,
    sinceSeq: drained.sinceSeq, lastSeq: drained.lastSeq, atHead: drained.atHead,
  });

  // ── STEP 2 — COMMIT A: the irreplaceable bytes become durable ─────────────
  const receipt = await writeFeedBlob(store, drained, now);
  bytesWritten += receipt.rows * 100;
  log.info('COMMIT A feed blob', { key: receipt.key, rows: receipt.rows });

  // ── STEP 3 — COMMIT B: only now may the cursor move ───────────────────────
  // `advance` cannot be called without the receipt above. That is a type-level
  // guarantee, not a convention — see feed.ts.
  cursor = cursorMod.advance(cursor, receipt, now);
  await cursorMod.write(store, cursor);
  log.info('COMMIT B cursor advanced', { lastSeq: cursor.lastSeq });

  // ── STEP 4: fetch packuments ──────────────────────────────────────────────
  // A newer rev supersedes an older queue entry: its `time` map is a superset, so
  // one fetch covers both. This is what collapses a multi-day backlog.
  const queue = dedupeByNameKeepingNewest([...recovered, ...deferredRows, ...drained.rows]);
  const mode: RunSummary['mode'] =
    queue.length > TRIAGE_THRESHOLD ? 'triage'
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
  const remaining: FeedRow[] = [];

  if (recovered.length > 0) {
    await shards.add(gap(runId, 'recovered', now, { detail: `rows=${recovered.length}` }));
  }

  if (mode === 'triage') {
    // Anti-wedge: enrichment must never starve capture. The names are safe in
    // raw/feed either way, so this only defers work — it never loses it.
    log.warn('TRIAGE: queue too deep, capturing feed only', { queue: queue.length });
    await shards.add(gap(runId, 'triage', now, { detail: `queue=${queue.length}` }));
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

      const result = await fetchPackument(row.id, limiter);
      fetched++;

      let packumentKey: string | null = null;
      const draft = buildObservation({ runId, row, result, now, packumentKey: null });

      // MEASURED on a live sample: this retains ~11% of changed packages at a mean
      // of 3.2 KB gzipped. Retaining every packument would be 3.54 GB/day.
      if (result.raw !== null && shouldRetainPackument(draft) && result.doc !== null) {
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
  await shards.flush();
  for (const s of shards.shards) bytesWritten += s.gzBytes;

  // ── STEP 5 — COMMIT C: deferred queue FIRST, then the manifest ────────────
  // Always rewritten, even when empty — otherwise the entries this run consumed
  // would linger and be reprocessed forever. Overwriting is what removes the need
  // for a delete-capable credential.
  const deduped = dedupeByNameKeepingNewest(remaining);
  const written = await putJsonl(store, keys.deferred(), deduped, assertNoPII);
  bytesWritten += written.gzBytes;
  if (deduped.length > 0) {
    await shards.add(gap(runId, 'deferred', now, { detail: `count=${deduped.length}` }));
    log.info('deferred', { count: deduped.length });
  }

  const manifest = {
    runId,
    schema: 1,
    startedAt: now.toISOString(),
    completedAt: new Date().toISOString(),
    sinceSeq: receipt.sinceSeq,
    lastSeq: receipt.lastSeq,
    mode,
    feedBlob: { key: receipt.key, sha256: receipt.sha256, rows: receipt.rows },
    obsShards: shards.shards,
    queued: queue.length,
    fetched,
    deferred: remaining.length,
    bytesWritten,
  };
  await store.put(
    keys.manifest(now, runId),
    Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
  );

  // ── STEP 6 — COMMIT D: record completion ──────────────────────────────────
  cursor = cursorMod.withRunComplete(cursor, runId, new Date(), bytesWritten);
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
    bytesWritten,
    mode,
  };
  log.info('run complete', { ...summary, elapsedMs: Date.now() - startedAt });
  return summary;
}

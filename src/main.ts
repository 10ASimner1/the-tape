/**
 * Entrypoint. Dispatches a mode, owns the process exit code, and makes a missing
 * PII salt a startup failure rather than a surprise three commits later.
 */

import { argv, env, exit } from 'node:process';

import * as cursorMod from './cursor.ts';
import { headSeq } from './feed.ts';
import { Healthcheck } from './healthcheck.ts';
import { log, writeStepSummary } from './log.ts';
import { build } from './index/build.ts';
import * as budgetMod from './budget.ts';
import * as ledgerMod from './ledger.ts';
import * as mirrorMod from './mirror.ts';
import { collect, render } from './index/digest.ts';
import { syncOsv } from './osv.ts';
import { record } from './run.ts';
import { FsStore } from './store.fs.ts';
import { inspectS3Env, S3_MIRROR_ENV_PREFIX, S3Store } from './store.s3.ts';
import { keys, runIdFrom, type Store } from './store.ts';

/** MEASURED: ~103,000 seq per 24h. Deliberately rounded UP — over-reaching
 *  backwards only re-observes packages (duplicates, which are free), while
 *  under-reaching loses events, which is not. */
const SEQ_PER_HOUR = 5_000;

function flag(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
}

/**
 * Chooses a store, and refuses to guess.
 *
 * The local filesystem store is OPT-IN — either `--local` or an explicit
 * `TAPE_STORE_DIR`. It used to be the silent fallback whenever the S3 config was
 * incomplete, which meant a mistyped or rotated secret sent an entire CI run to
 * the runner's ephemeral disk, exited zero, and pinged the healthcheck as
 * success. Every alarm we have would have pointed the wrong way: the tape would
 * have looked perfectly healthy while recording nothing.
 *
 * So: a partial S3 config is a startup error, never a downgrade.
 */
function makeStore(): Store {
  const local = argv.includes('--local');
  const storeDir = env['TAPE_STORE_DIR'];
  const { config, present, missing } = inspectS3Env(env);

  if (local || (storeDir !== undefined && config === null)) {
    const root = storeDir ?? '.tape-store';
    log.info('store', { kind: 'fs', root });
    return new FsStore(root);
  }

  if (config !== null) {
    log.info('store', { kind: 's3', bucket: config.bucket, region: config.region });
    return new S3Store(config);
  }

  if (present.length > 0) {
    throw new Error(
      `object store is only partially configured: ${present.length} of ${present.length + missing.length} ` +
        `variables set, missing ${missing.join(', ')}. Refusing to fall back to local disk — ` +
        `on a CI runner that silently discards the run while reporting success.`,
    );
  }

  throw new Error(
    `no object store configured. Set ${missing.join(', ')} (see .env.example), ` +
      `or pass --local to write to the filesystem deliberately.`,
  );
}

/**
 * Chooses the SECOND store, with the same discipline as makeStore().
 *
 * Note what is fatal: no mirror configured at all. A `mirror` run that finds
 * nothing to copy to and exits zero is precisely the failure that made a partial
 * S3 config fatal in the first place — the alarm points the wrong way, and the
 * backup that does not exist looks healthy.
 */
function makeMirrorStore(): Store {
  const localDir = flag('mirror-local') ?? env['TAPE_MIRROR_DIR'];
  const { config, present, missing } = inspectS3Env(env, S3_MIRROR_ENV_PREFIX);

  if (localDir !== undefined && config === null) {
    log.info('mirror store', { kind: 'fs', root: localDir });
    return new FsStore(localDir);
  }
  if (config !== null) {
    log.info('mirror store', { kind: 's3', bucket: config.bucket, region: config.region });
    return new S3Store(config);
  }
  if (present.length > 0) {
    throw new Error(
      `the mirror is only partially configured: ${present.length} of ` +
        `${present.length + missing.length} variables set, missing ${missing.join(', ')}.`,
    );
  }
  throw new Error(
    `no mirror configured, so there is nothing to copy to. Set ${missing.join(', ')}, or pass ` +
      `--mirror-local <dir> to copy to disk. Refusing to exit zero having backed up nothing.`,
  );
}

/**
 * Copies whatever the mirror is missing, and reports what it cannot decide.
 *
 * Read-only on the primary by construction: everything it writes goes to the
 * mirror, including its own bookkeeping.
 */
async function runMirror(primary: Store): Promise<void> {
  const target = makeMirrorStore();
  mirrorMod.assertDistinctConfig(primary, target);
  mirrorMod.assertSamePrimary(await mirrorMod.readState(target), primary);

  const verifyFlag = flag('verify');
  const maxObjects = flag('max-objects');
  const report = await mirrorMod.mirror({
    primary,
    mirror: target,
    now: new Date(),
    repair: argv.includes('--repair'),
    ...(verifyFlag !== undefined
      ? { verify: verifyFlag === 'all' ? ('all' as const) : Number(verifyFlag) }
      : {}),
    ...(maxObjects !== undefined ? { maxObjects: Number(maxObjects) } : {}),
  });

  log.info('mirror complete', {
    copied: report.copied, bytes: report.bytes, mismatched: report.mismatched,
    vanished: report.vanished, verified: report.verified,
    verifyFailures: report.verifyFailures.length, complete: report.complete,
  });

  await writeStepSummary([
    `### tape: mirror`,
    '',
    `| metric | value |`,
    `| --- | --- |`,
    `| objects copied | ${report.copied} |`,
    `| bytes copied | ${report.bytes} |`,
    `| size mismatches | ${report.mismatched} |`,
    `| vanished | ${report.vanished} |`,
    `| deep-verified | ${report.verified} (${report.verifyFailures.length} failed) |`,
    `| swept every prefix | ${report.complete} |`,
  ]);

  // A size mismatch means one side is corrupt and which one is a human decision,
  // so this fails rather than guessing. An incomplete sweep does NOT fail: the
  // next run resumes from a fresh diff, which is the whole point of holding no
  // state. Nothing here is ever a reason to touch the primary.
  const defects = report.mismatched + report.vanished + report.verifyFailures.length;
  if (defects > 0) {
    throw new Error(
      `mirror found ${defects} discrepancy(ies): ${report.mismatched} size mismatch(es), ` +
        `${report.vanished} vanished, ${report.verifyFailures.length} hash mismatch(es). ` +
        `Nothing was repaired — pass --repair only after deciding which side is right.`,
    );
  }
}

async function bootstrap(store: Store): Promise<void> {
  const existing = await cursorMod.read(store);
  if (existing !== null && flag('force') === undefined) {
    throw new Error(
      `a cursor already exists at lastSeq=${existing.lastSeq}. Re-bootstrapping would ` +
        `skip every event between it and now. Pass --force if that is genuinely intended.`,
    );
  }
  const head = await headSeq();
  const hours = Number(flag('hours') ?? '1');
  // `since=now` returns HTTP 400, so the head comes from the DB root document and
  // the lookback is an ESTIMATE from the measured seq rate — seq is sparse and the
  // ratio drifts, so this is never treated as exact.
  const start = Math.max(0, head - Math.round(hours * SEQ_PER_HOUR));
  await cursorMod.write(store, cursorMod.initial(start, new Date()));
  log.info('bootstrapped', { head, lastSeq: start, approxHours: hours });
}

/**
 * Round-trips one throwaway object through every store operation. Verifies
 * credentials, endpoint, region and SigV4 signing in a few seconds, rather than
 * discovering a problem thirty minutes into a recording run.
 */
async function storeCheck(store: Store): Promise<void> {
  // A fixed key, overwritten every time: this runs before every recording run, so
  // a timestamped key would litter the bucket ~96 times a day — and with a
  // no-delete credential there would be no way to clean it up.
  const key = keys.selfCheck();
  const payload = Buffer.from(`the-tape store check\n`, 'utf8');

  await store.put(key, payload);
  log.info('  put     ok', { key });

  const got = await store.get(key);
  if (got === null || Buffer.compare(Buffer.from(got), payload) !== 0) {
    throw new Error('store check failed: the object read back did not match what was written');
  }
  log.info('  get     ok', { bytes: got.length });

  const absent = await store.get(`${key}.does-not-exist`);
  if (absent !== null) throw new Error('store check failed: a missing key did not return null');
  log.info('  get 404 ok');

  const again = await store.putIfAbsent(key, payload);
  if (again.written) throw new Error('store check failed: putIfAbsent overwrote an existing key');
  log.info('  putIfAbsent ok', { written: false });

  const listed = await store.list('state/selfcheck/');
  if (!listed.some((o) => o.key === key)) {
    throw new Error(`store check failed: list did not return the key it just wrote`);
  }
  log.info('  list    ok', { found: listed.length });

  // Deliberately does NOT exercise delete. The recorder no longer deletes
  // anything, and the credential it runs on should not be able to — testing for a
  // capability we want absent would be backwards.
  log.info('store check passed');
}

/**
 * Mirrors the OSV delta, rebuilds the index from raw, and writes the day's digest.
 *
 * Runs nightly and entirely out of band: it never touches the recorder's path, so
 * a failure here delays the digest and costs nothing on the tape.
 */
async function buildIndex(store: Store): Promise<void> {
  const now = new Date();
  const runId = runIdFrom(now);

  // OSV lives here rather than in the hourly recorder deliberately. The recorder
  // is the thing that must never break, and a second network dependency buys ~12
  // hours of latency on a signal that already lags three.
  const cursor = await cursorMod.read(store);
  if (cursor !== null) {
    const osv = await syncOsv(store, cursor.osvWatermark, now, runId);
    if (osv.watermark !== cursor.osvWatermark && osv.watermark !== null) {
      // Re-read before writing, and carry over only this one field.
      //
      // syncOsv is an unbounded network operation, and this job (`23 3 * * *`) is
      // in a DIFFERENT Actions concurrency group from the recorder (`:07,:22,:37,
      // :52`), so they overlap by design. Writing back the snapshot read above
      // would clobber a lastSeq or pendingFeedKey that a recording run advanced
      // in the meantime. Backwards is only duplicates, never loss — but the
      // cursor also carries monotonic byte accounting for the spend cap, and a
      // clobbered counter under-counts against a cap.
      const fresh = (await cursorMod.read(store)) ?? cursor;
      await cursorMod.write(store, cursorMod.withOsvWatermark(fresh, osv.watermark));
    }
  }

  const dbPath = flag('db') ?? '.tape-index.sqlite';
  const stats = await build(store, dbPath);

  // Yesterday by default: today is still accumulating.
  const requested = flag('date');
  if (requested !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(requested)) {
    // Validated because this value originates from a workflow_dispatch input and
    // ends up in a filename. Anything but a plain date is rejected outright.
    throw new Error(`--date must be YYYY-MM-DD, got "${requested}"`);
  }
  const date = requested ?? new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath);
  const digest = render(collect(db, date));
  db.close();

  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir('digests', { recursive: true });
  await writeFile(`digests/${date}.md`, digest.markdown, 'utf8');
  await writeFile(`digests/${date}.json`, digest.json, 'utf8');
  log.info('digest written', { date, events: stats.events, packages: stats.packages });

  // Lets the workflow upload exactly the day it rendered, rather than the whole
  // digests/ directory — which would otherwise let the publish job re-commit
  // every previously published digest.
  const outputPath = env['GITHUB_OUTPUT'];
  if (outputPath !== undefined) {
    const { appendFile } = await import('node:fs/promises');
    await appendFile(outputPath, `date=${date}
`, 'utf8');
  }
}

/**
 * Transcribes a day of manifests into `ledger/<date>.jsonl`.
 *
 * ALWAYS exits zero, even over a broken chain. The day the chain breaks must not
 * also be the day the evidence fails to reach git, so anomalies are recorded as
 * lines here and the alarm is raised by a later step, after the commit.
 */
async function writeLedger(store: Store): Promise<void> {
  const date = flag('date') ?? new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const day = new Date(`${date}T00:00:00Z`);

  const manifests = await ledgerMod.readManifests(store, day);
  const lines = ledgerMod.transcribe(date, manifests);
  const anomalies = lines.filter((l): l is ledgerMod.LedgerAnomaly => l.k === 'anomaly');

  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir('ledger', { recursive: true });
  await writeFile(`ledger/${date}.jsonl`, ledgerMod.formatLedger(lines), 'utf8');

  log.info('ledger written', {
    date,
    runs: manifests.length,
    anomalies: anomalies.length,
    defects: anomalies.filter(ledgerMod.isDefect).length,
  });
}

/**
 * Checks the chain across the committed ledger, and optionally against the store.
 *
 * The default path reads only files in the repo — no credentials, no bucket. That
 * is the point: the ledger is a public record precisely because anyone holding a
 * clone can verify it without being trusted with anything.
 */
async function verifyChainFromRepo(store: Store | null): Promise<void> {
  const { readdir, readFile } = await import('node:fs/promises');
  const from = flag('from');

  let files: string[];
  try {
    files = (await readdir('ledger')).filter((f) => f.endsWith('.jsonl')).sort();
  } catch {
    throw new Error('no ledger/ directory in this repo; run `ledger` first, or clone the repo');
  }
  if (from !== undefined) files = files.filter((f) => f.slice(0, 10) >= from);
  if (files.length === 0) throw new Error('no ledger files to verify');

  const lines: ledgerMod.LedgerLine[] = [];
  for (const file of files) {
    lines.push(...ledgerMod.parseLedger(await readFile(`ledger/${file}`, 'utf8')));
  }

  const report = ledgerMod.verifyChain(lines);
  for (const a of report.anomalies) {
    const at = { runId: a.runId, sibling: a.sibling, detail: a.detail };
    if (ledgerMod.isDefect(a)) log.error(`chain ${a.kind}`, at);
    else log.info(`chain ${a.kind}`, at);
  }

  let storeDefects = 0;
  if (store !== null) {
    // The tamper signal that the chain alone cannot give: a manifest sitting in
    // the bucket that was never committed to the ledger for the day it claims.
    const committed = new Set(
      lines.filter((l): l is ledgerMod.LedgerRun => l.k === 'run').map((r) => r.sha256),
    );
    for (const file of files) {
      const day = new Date(`${file.slice(0, 10)}T00:00:00Z`);
      for (const m of await ledgerMod.readManifests(store, day)) {
        if (committed.has(m.sha256)) continue;
        storeDefects++;
        log.error('manifest in the archive is absent from the committed ledger', {
          key: m.key, runId: m.manifest.runId, sha256: m.sha256,
        });
      }
    }
  }

  const total = report.defects + storeDefects;
  log.info('chain verified', {
    files: files.length, runs: report.runs, defects: total,
    scope: store === null ? 'ledger-only' : 'ledger+archive',
  });
  if (total > 0) throw new Error(`chain verification found ${total} defect(s)`);
}

/**
 * Rebuilds the archive from the mirror alone, and checks the result.
 *
 * An untested backup is a hope, not a backup. This is Part III §6's restore drill
 * and M4's "full rebuild-from-raw" acceptance criterion, and it is almost
 * entirely a composition of modes that already exist — build() has always taken a
 * Store, so pointing it at the mirror is the whole trick.
 */
async function restoreDrill(): Promise<void> {
  // THE most important line in this mode. A restore drill with the primary
  // available is not a drill: every fallback silently works and you learn
  // nothing. The workflow enforces this too, by not providing the credentials.
  if (inspectS3Env(env).present.length > 0) {
    throw new Error(
      'refusing to run a restore drill with the primary store configured. Unset the TAPE_S3_* ' +
        'variables. A drill that can still reach the primary proves nothing — every fallback ' +
        'would quietly succeed against the archive you are pretending to have lost.',
    );
  }

  const target = makeMirrorStore();
  const into = flag('into') ?? '.tape-restore';
  const date = flag('date') ?? new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

  // 1. The cursor is NOT mirrored, so this is re-derived from the feed keys —
  //    which means the drill exercises that recovery path every single time.
  const recovered = await cursorMod.recoverFromArchive(target);
  if (recovered === null) throw new Error('the mirror holds no feed objects; nothing to restore');

  const manifests = await ledgerMod.readManifests(target, new Date(`${date}T00:00:00Z`));
  const highest = manifests.reduce((n, m) => Math.max(n, m.manifest.lastSeq), 0);
  log.info('cursor re-derived from the mirror', { lastSeq: recovered, manifestsThatDay: manifests.length });

  // 2. If the index builds from the mirror, the mirror is a working archive.
  const { mkdir } = await import('node:fs/promises');
  await mkdir(into, { recursive: true });
  const dbPath = `${into}/index.sqlite`;
  const stats = await build(target, dbPath);

  // 3. Re-render the day and compare against what was published at the time.
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath);
  const rebuilt = render(collect(db, date));
  db.close();

  const { readFile, writeFile } = await import('node:fs/promises');
  await writeFile(`${into}/${date}.md`, rebuilt.markdown, 'utf8');

  let published: string | null = null;
  try {
    published = await readFile(`digests/${date}.md`, 'utf8');
  } catch {
    log.warn('no committed digest to compare against', { date });
  }

  // The graveyard is the hard assertion: it derives purely from observations, so
  // it must reproduce exactly. The typosquat section depends on the pinned
  // high-impact list, which can legitimately have moved since — a difference
  // there is information, not a failure.
  const graveyard = (text: string) => text.split(/^## /m).find((s) => /^graveyard/i.test(s)) ?? '';
  let graveyardMatches: boolean | null = null;
  if (published !== null) {
    graveyardMatches = graveyard(published).trim() === graveyard(rebuilt.markdown).trim();
    if (!graveyardMatches) log.error('the rebuilt graveyard differs from the published one', { date });
    else if (published !== rebuilt.markdown) {
      log.info('digest differs outside the graveyard (typosquat list may have moved)', { date });
    }
  }

  // 4. And the chain, against the ledger committed in this repo.
  const chain = ledgerMod.verifyChain(
    ledgerMod.transcribe(date, manifests),
  );

  log.info('restore drill complete', {
    into, date,
    lastSeq: recovered,
    manifestsLastSeq: highest,
    events: stats.events,
    packages: stats.packages,
    graveyardMatches,
    chainDefects: chain.defects,
  });

  if (graveyardMatches === false || chain.defects > 0) {
    throw new Error('restore drill FAILED: the mirror did not reproduce the published record');
  }
}

/**
 * Measures what the bucket actually holds, and writes the spend cap's anchor.
 *
 * Runs nightly inside the index job, which already holds credentials and already
 * writes to the primary. Deliberately NOT hourly: it lists the whole store, and
 * putting that in the recorder's critical section to maintain a counter is
 * exactly the trade rule 1 forbids.
 *
 * The number is MEASURED rather than projected on purpose. It is the only value
 * allowed to make the recorder degrade itself, and a storage figure estimated at
 * a desk was wrong by 13x once already in this project.
 */
async function writeUsage(store: Store): Promise<void> {
  const usage = await budgetMod.measure(store, new Date());
  await budgetMod.write(store, usage);

  const ceiling = budgetMod.ceilingBytes(env);
  log.info('storage measured', {
    objects: usage.objects,
    storedBytes: usage.storedBytes,
    ceiling,
    pct: Math.round((usage.storedBytes / ceiling) * 100),
    byPrefix: Object.entries(usage.byPrefix)
      .map(([p, v]) => `${p}=${v.bytes}`)
      .join(' '),
  });
}

async function recoverCursor(store: Store): Promise<void> {
  const recovered = await cursorMod.recoverFromArchive(store);
  if (recovered === null) throw new Error('no feed objects in the archive to recover from');
  const existing = await cursorMod.read(store);
  const base = existing ?? cursorMod.initial(recovered, new Date());

  // Moving BACKWARDS only causes duplicates and is always safe; moving forwards
  // past unfetched rows is the direction that loses events. So a rewind is
  // allowed, and an advance is not.
  if (existing !== null && recovered > existing.lastSeq && flag('force-rewind') === undefined) {
    throw new Error(
      `the archive's highest recorded seq (${recovered}) is AHEAD of the stored cursor ` +
        `(${existing.lastSeq}). Moving the cursor forwards would skip everything between ` +
        `them. Pass --force-rewind only if you have confirmed those rows were processed.`,
    );
  }
  log.info('recovered cursor from archive', { was: existing?.lastSeq ?? null, now: recovered });
  await cursorMod.write(store, { ...base, lastSeq: recovered, pendingFeedKey: null });
}

/**
 * Modes that provably never hash an address, and so must not demand the salt.
 *
 * The salt is the one secret that cannot be regenerated — every maintainer hash
 * already in the archive derives from it. Requiring it in a mode that has no use
 * for it would put it in the environment of jobs that have no business holding
 * it, which is the opposite of least privilege.
 */
const SALT_FREE_MODES = new Set([
  'recover-cursor', 'ledger', 'verify-chain', 'mirror', 'restore-drill', 'usage',
]);

async function main(): Promise<void> {
  const mode = argv[2] ?? 'record';

  // Fail here rather than after the first blob is written: without a salt the
  // maintainer hashes would be unsalted, and an unsalted hash of an email is a
  // reversible email.
  if (env['TAPE_PII_SALT'] === undefined && !SALT_FREE_MODES.has(mode)) {
    throw new Error(
      'TAPE_PII_SALT is not set. Generate one with:\n' +
        '  node -e "console.log(require(\'node:crypto\').randomBytes(32).toString(\'hex\'))"\n' +
        'then export it (locally) or add it as an Actions secret. It must never change ' +
        'once the archive has data — the hashes would stop joining across time.',
    );
  }

  // Verifying the chain from the committed ledger is the whole public claim, so
  // it must run with NO credentials at all. Constructing a store eagerly would
  // have made that impossible.
  if (mode === 'verify-chain' && !argv.includes('--store')) {
    await verifyChainFromRepo(null);
    return;
  }

  // The drill deliberately runs with NO primary, so it must not construct one.
  if (mode === 'restore-drill') {
    await restoreDrill();
    return;
  }

  const store = makeStore();

  switch (mode) {
    case 'mirror':
      await runMirror(store);
      return;
    case 'usage':
      await writeUsage(store);
      return;
    case 'ledger':
      await writeLedger(store);
      return;
    case 'verify-chain':
      await verifyChainFromRepo(store);
      return;
    case 'bootstrap':
      await bootstrap(store);
      return;
    case 'recover-cursor':
      await recoverCursor(store);
      return;
    case 'store-check':
      await storeCheck(store);
      return;
    case 'index':
      await buildIndex(store);
      return;
    case 'record': {
      const maxFetch = flag('max-fetch');
      const health = new Healthcheck(env['TAPE_HEALTHCHECK_URL']);
      await health.start();

      let summary;
      try {
        summary = await record({
          store,
          ...(maxFetch !== undefined ? { maxFetch: Number(maxFetch) } : {}),
        });
      } catch (err) {
        await health.fail();
        throw err;
      }
      await health.success();
      await writeStepSummary([
        `### tape: seq ${summary.sinceSeq}..${summary.lastSeq}`,
        '',
        `| metric | value |`,
        `| --- | --- |`,
        `| feed rows | ${summary.feedRows} |`,
        `| distinct packages | ${summary.distinctPackages} |`,
        `| fetched | ${summary.fetched} |`,
        `| deferred | ${summary.deferred} |`,
        `| flagged | ${summary.flagged} |`,
        `| package unpublishes | ${summary.unpublishes} |`,
        `| version unpublishes | ${summary.versionUnpublishes} (across ${summary.packagesWithYanks} packages) |`,
        `| packuments retained | ${summary.retained} |`,
        `| bytes written | ${summary.bytesWritten} |`,
        `| mode | ${summary.mode}${summary.triageReason === null ? '' : ` (${summary.triageReason})`} |`,
        // On EVERY run, not just degraded ones. A number an operator only sees
        // once it is already a problem is a number nobody was watching.
        `| storage | ${budgetMod.describe(summary.storage)} |`,
        `| retention skipped | ${summary.retentionSkipped} |`,
      ]);
      return;
    }
    default:
      throw new Error(
        `unknown mode "${mode}". Use: bootstrap | record | index | store-check | ` +
          `recover-cursor | ledger | verify-chain | mirror | restore-drill | usage`,
      );
  }
}

main().catch((err: unknown) => {
  // Never print the error object wholesale — workflow logs are public and an
  // error can carry a response body.
  log.error('run failed', {
    kind: err instanceof Error ? err.name : 'unknown',
    msg: err instanceof Error ? err.message : String(err),
  });
  exit(1);
});

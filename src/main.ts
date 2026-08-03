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
import { collect, render } from './index/digest.ts';
import { syncOsv } from './osv.ts';
import { record } from './run.ts';
import { FsStore } from './store.fs.ts';
import { inspectS3Env, S3Store } from './store.s3.ts';
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
      await cursorMod.write(store, cursorMod.withOsvWatermark(cursor, osv.watermark));
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

async function main(): Promise<void> {
  const mode = argv[2] ?? 'record';

  // Fail here rather than after the first blob is written: without a salt the
  // maintainer hashes would be unsalted, and an unsalted hash of an email is a
  // reversible email.
  if (env['TAPE_PII_SALT'] === undefined && mode !== 'recover-cursor') {
    throw new Error(
      'TAPE_PII_SALT is not set. Generate one with:\n' +
        '  node -e "console.log(require(\'node:crypto\').randomBytes(32).toString(\'hex\'))"\n' +
        'then export it (locally) or add it as an Actions secret. It must never change ' +
        'once the archive has data — the hashes would stop joining across time.',
    );
  }

  const store = makeStore();

  switch (mode) {
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
        `| bytes written | ${summary.bytesWritten} |`,
        `| mode | ${summary.mode} |`,
      ]);
      return;
    }
    default:
      throw new Error(`unknown mode "${mode}". Use: bootstrap | record | index | store-check | recover-cursor`);
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

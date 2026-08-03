/**
 * Entrypoint. Dispatches a mode, owns the process exit code, and makes a missing
 * PII salt a startup failure rather than a surprise three commits later.
 */

import { argv, env, exit } from 'node:process';

import * as cursorMod from './cursor.ts';
import { headSeq } from './feed.ts';
import { Healthcheck } from './healthcheck.ts';
import { log, writeStepSummary } from './log.ts';
import { record } from './run.ts';
import { FsStore } from './store.fs.ts';
import { s3ConfigFromEnv, S3Store } from './store.s3.ts';
import type { Store } from './store.ts';

/** MEASURED: ~103,000 seq per 24h. Deliberately rounded UP — over-reaching
 *  backwards only re-observes packages (duplicates, which are free), while
 *  under-reaching loses events, which is not. */
const SEQ_PER_HOUR = 5_000;

function flag(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
}

function makeStore(): Store {
  // S3 when configured, local disk otherwise. Both satisfy the same four-method
  // interface, so tests and offline development never need credentials.
  const s3 = s3ConfigFromEnv(env);
  if (s3 !== null) {
    log.info('store', { kind: 's3', bucket: s3.bucket, region: s3.region });
    return new S3Store(s3);
  }
  const root = env['TAPE_STORE_DIR'] ?? '.tape-store';
  log.info('store', { kind: 'fs', root });
  return new FsStore(root);
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
  // A scoped package name in the key on purpose: percent-encoding is double-encoded
  // during signing, and scoped names are 77.5% of npm, so this is the case that
  // breaks first if the encoder is wrong.
  const key = `state/selfcheck/${encodeURIComponent('@tape/self-check')}-${Date.now()}.txt`;
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

  try {
    await store.delete(key);
    log.info('  delete  ok');
  } catch {
    // Expected if the credential deliberately lacks delete rights, which is the
    // hardened configuration Part III asks for.
    log.warn('  delete  refused — expected if the key has no delete capability');
  }
  log.info('store check passed');
}

async function recoverCursor(store: Store): Promise<void> {
  const recovered = await cursorMod.recoverFromArchive(store);
  if (recovered === null) throw new Error('no feed objects in the archive to recover from');
  const existing = await cursorMod.read(store);
  const base = existing ?? cursorMod.initial(recovered, new Date());
  log.info('recovered cursor from archive', { was: existing?.lastSeq ?? null, now: recovered });
  await cursorMod.write(store, { ...base, lastSeq: recovered });
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
      throw new Error(`unknown mode "${mode}". Use: bootstrap | record | store-check | recover-cursor`);
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

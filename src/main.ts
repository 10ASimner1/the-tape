/**
 * Entrypoint. Dispatches a mode, owns the process exit code, and makes a missing
 * PII salt a startup failure rather than a surprise three commits later.
 */

import { argv, env, exit } from 'node:process';

import * as cursorMod from './cursor.ts';
import { headSeq } from './feed.ts';
import { log, writeStepSummary } from './log.ts';
import { record } from './run.ts';
import { FsStore } from './store.fs.ts';
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
  // M1 runs entirely on local disk, so no cloud provider decision is needed to
  // start. store.s3.ts (hand-rolled SigV4, zero deps) lands at M2 behind the
  // same four-method interface.
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
    case 'record': {
      const maxFetch = flag('max-fetch');
      const summary = await record({
        store,
        ...(maxFetch !== undefined ? { maxFetch: Number(maxFetch) } : {}),
      });
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
      throw new Error(`unknown mode "${mode}". Use: bootstrap | record | recover-cursor`);
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

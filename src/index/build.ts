/**
 * Builds the SQLite index from the raw archive.
 *
 * The index is disposable by design: delete it, run this, get the same answers.
 * That is the property the observation row's absoluteness buys, and it is what
 * makes every rule here changeable later — improve the typosquat scoring in month
 * eight and one re-run re-scores all of history.
 *
 * Streams the archive in run order, holding one prior observation per package
 * rather than years of them, because every derivation rule compares against the
 * immediately previous observation only.
 *
 * Zero dependencies: `node:sqlite` ships with Node 24.
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import { decodeJsonl } from '../jsonl.ts';
import { log } from '../log.ts';
import type { Gap, Observation, Row } from '../observation.ts';
import { affectsOf, type OsvRecord } from '../osv.ts';
import type { Store } from '../store.ts';
import { deriveStep, isDiffable, type DerivedEvent } from './derive.ts';
import { PopularIndex, scoreName } from './typosquat.ts';

const here = dirname(fileURLToPath(import.meta.url));

export type BuildStats = {
  readonly observations: number;
  readonly packages: number;
  readonly events: number;
  readonly gaps: number;
  readonly osvRecords: number;
  readonly typosquatScored: number;
  readonly shards: number;
};

/**
 * The prior observation, trimmed to exactly what the derivation reads.
 *
 * Retaining whole Observation objects for every package ever seen was measured as
 * the build's memory ceiling: at ~3M packages with their `times`, `missing` and
 * `recent` arrays attached it exhausts the runner, and it would do so inside an
 * open transaction. These four fields are all `deriveStep` touches.
 */
type PriorState = Pick<Observation, 'maintainerHashes' | 'maintainers' | 'revInt'> & {
  readonly times: Observation['times'];
};

const toPrior = (o: Observation): PriorState => ({
  maintainerHashes: o.maintainerHashes,
  maintainers: o.maintainers,
  revInt: o.revInt,
  times: o.times,
});

function loadPopular(): PopularIndex {
  const path = join(here, '..', '..', 'data', 'high-impact.json');
  const { names } = JSON.parse(readFileSync(path, 'utf8')) as { names: string[] };
  return new PopularIndex(names);
}

export function createDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));
  return db;
}

export async function build(
  store: Store,
  dbPath: string,
  opts: { since?: string } = {},
): Promise<BuildStats> {
  const db = createDatabase(dbPath);
  const popular = loadPopular();

  const insertObs = db.prepare(
    `INSERT OR REPLACE INTO observations
       (name, run_id, seq, rev, rev_int, fetched_at, status, outcome, version_count,
        truncated, missing_count, recent_count)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const insertEvent = db.prepare(
    `INSERT OR IGNORE INTO events
       (id, kind, name, version, at, observed_at, run_id, seq, backfill, detail)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  );
  const insertGap = db.prepare(
    `INSERT INTO gaps (run_id, kind, name, seq, status, detail, at) VALUES (?,?,?,?,?,?,?)`,
  );
  const upsertPackage = db.prepare(
    `INSERT INTO packages
       (name, first_seen, last_seen, created, latest_version, version_count,
        observations, is_dead, unpublished_at, security_holder, maintainers, flags)
     VALUES (?,?,?,?,?,?,1,?,?,?,?,?)
     ON CONFLICT(name) DO UPDATE SET
       last_seen       = excluded.last_seen,
       created         = COALESCE(excluded.created, packages.created),
       latest_version  = COALESCE(excluded.latest_version, packages.latest_version),
       version_count   = COALESCE(excluded.version_count, packages.version_count),
       observations    = packages.observations + 1,
       is_dead         = MAX(packages.is_dead, excluded.is_dead),
       unpublished_at  = COALESCE(excluded.unpublished_at, packages.unpublished_at),
       security_holder = COALESCE(excluded.security_holder, packages.security_holder),
       maintainers     = COALESCE(excluded.maintainers, packages.maintainers),
       flags           = excluded.flags`,
  );
  const insertTyposquat = db.prepare(
    `INSERT OR REPLACE INTO typosquat (name, score, nearest) VALUES (?,?,?)`,
  );
  const insertOsv = db.prepare(
    `INSERT OR REPLACE INTO osv_records (id, modified, published, summary, is_malicious, raw)
     VALUES (?,?,?,?,?,?)`,
  );
  const insertAffects = db.prepare(
    `INSERT OR IGNORE INTO osv_affects (osv_id, name, version, basis) VALUES (?,?,?,?)`,
  );
  const setMeta = db.prepare(`INSERT OR REPLACE INTO build_meta (key, value) VALUES (?,?)`);

  const stats = {
    observations: 0, events: 0, gaps: 0, osvRecords: 0, typosquatScored: 0, shards: 0,
  };
  const prior = new Map<string, PriorState>();
  const scored = new Set<string>();

  // Shard keys embed the run id, so lexical order is chronological order — which
  // is what the derivation depends on.
  const shardKeys = (await store.list('raw/obs/'))
    .map((o) => o.key)
    .filter((k) => opts.since === undefined || k >= opts.since)
    .sort();

  db.exec('BEGIN');
  for (const key of shardKeys) {
    const bytes = await store.get(key);
    if (bytes === null) continue;
    stats.shards++;

    for (const row of decodeJsonl<Row>(gunzipSync(bytes).toString('utf8'))) {
      if (row.k === 'gap') {
        const g = row as Gap;
        insertGap.run(g.run, g.kind, g.name, g.seq, g.status, g.detail, g.at);
        stats.gaps++;
        continue;
      }

      const obs = row as Observation;
      stats.observations++;

      insertObs.run(
        obs.name, obs.run, obs.seq, obs.rev, obs.revInt, obs.fetchedAt,
        obs.status, obs.outcome, obs.versionCount, obs.truncated ? 1 : 0,
        // Kept because a truncated row's LISTS are capped but its totals are not —
        // without these the true yank count of a churning package is unrecoverable
        // from the index.
        obs.missingCount, obs.recentCount,
      );
      // A 404 or a timeout carries no maintainers and no versions. Writing those
      // through would wipe what we already knew about the package on the strength
      // of a transient failure.
      upsertPackage.run(
        obs.name, obs.fetchedAt, obs.fetchedAt, obs.created,
        obs.distTags['latest'] ?? null,
        isDiffable(obs) ? obs.versionCount : null,
        obs.tombstone ? 1 : 0, obs.unpublishedAt, obs.securityHolder,
        isDiffable(obs) ? JSON.stringify(obs.maintainers) : null,
        JSON.stringify(obs.flags),
      );

      for (const e of deriveStep((prior.get(obs.name) as Observation | undefined) ?? null, obs)) {
        insertEvent.run(
          e.id, e.kind, e.name, e.version, e.at, e.observedAt,
          e.runId, e.seq, e.backfill ? 1 : 0, JSON.stringify(e.detail),
        );
        stats.events++;
      }
      // Only a real document may serve as the next diff's baseline.
      if (isDiffable(obs)) prior.set(obs.name, toPrior(obs));

      // Only brand-new names, and only once — an established package is not
      // squatting on anything, and rescoring it every observation is wasted work.
      if (obs.isNew && !scored.has(obs.name)) {
        scored.add(obs.name);
        const score = scoreName(obs.name, popular);
        if (score !== null) {
          insertTyposquat.run(score.name, score.score, JSON.stringify(score.nearest));
          stats.typosquatScored++;
        }
      }
    }
  }
  db.exec('COMMIT');

  // ── OSV ───────────────────────────────────────────────────────────────────
  // Stored separately and joined by name/version at query time, so a record that
  // arrives 128 days after the event it describes still attaches. There is no
  // backfill pass and no window past which a late record stops mattering.
  db.exec('BEGIN');
  for (const { key } of await store.list('raw/osv/')) {
    const bytes = await store.get(key);
    if (bytes === null) continue;
    for (const record of decodeJsonl<OsvRecord>(gunzipSync(bytes).toString('utf8'))) {
      insertOsv.run(
        record.id, record.modified ?? null, (record['published'] as string) ?? null,
        record.summary ?? null, record.id.startsWith('MAL-') ? 1 : 0, JSON.stringify(record),
      );
      stats.osvRecords++;
      for (const a of affectsOf(record)) insertAffects.run(a.osvId, a.name, a.version, a.basis);
    }
  }
  db.exec('COMMIT');

  const packages = (db.prepare('SELECT COUNT(*) AS n FROM packages').get() as { n: number }).n;
  setMeta.run('builtAt', new Date().toISOString());
  setMeta.run('observations', String(stats.observations));
  setMeta.run('events', String(stats.events));
  setMeta.run('popularListSize', String(popular.size));

  db.exec('PRAGMA optimize');
  db.close();

  const result: BuildStats = { ...stats, packages };
  log.info('index built', result);
  return result;
}

/** Events with an OSV record covering the exact version, or the package as a whole. */
export function osvHitsFor(db: DatabaseSync, name: string): unknown[] {
  return db
    .prepare(
      `SELECT r.id, r.summary, r.is_malicious, a.version
         FROM osv_affects a JOIN osv_records r ON r.id = a.osv_id
        WHERE a.name = ?
        ORDER BY r.is_malicious DESC, r.modified DESC`,
    )
    .all(name);
}

export type { DerivedEvent };

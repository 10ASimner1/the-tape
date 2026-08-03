import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { deriveAll, deriveForPackage, type DerivedEvent } from '../src/index/derive.ts';
import { buildObservation, type Observation } from '../src/observation.ts';
import { setSaltForTesting } from '../src/pii.ts';
import { packument } from './fixtures.ts';

setSaltForTesting('test-salt-0123456789abcdef');

/** A minimal observation; every test overrides only what it is about. */
function obs(over: Partial<Observation> & Pick<Observation, 'name' | 'fetchedAt'>): Observation {
  return {
    k: 'obs', schema: 1, run: over.fetchedAt, seq: 1, rev: '1-a', revInt: 1,
    feedDeleted: false, status: 200, outcome: 'ok', bytes: 0,
    created: null, modified: null, distTags: {}, maintainers: [], maintainerHashes: [],
    versionCount: 0, versionsDigest: null, times: [], missing: [], recent: [],
    missingCount: 0, recentCount: 0, truncated: false,
    tombstone: false, unpublishedAt: null, unpublishedBy: null, unpublishedVersions: [],
    securityHolder: null, isNew: false, installScriptVersions: [], packumentKey: null,
    flags: [], ...over,
  };
}

const kinds = (evts: DerivedEvent[], kind: string) => evts.filter((e) => e.kind === kind);
const versions = (evts: DerivedEvent[], kind: string) =>
  kinds(evts, kind).map((e) => e.version).sort();

describe('publish — recovering what the feed collapses away', () => {
  it('emits one event per version the previous observation did not have', () => {
    // The feed shows ONE row for a package that published five versions between
    // runs. Recovering the other four is the whole point of the time map.
    const events = deriveForPackage([
      obs({ name: 'p', fetchedAt: '2026-08-01T00:00:00.000Z', times: [['1.0.0', 100]] }),
      obs({
        name: 'p', fetchedAt: '2026-08-01T01:00:00.000Z', revInt: 2,
        times: [['1.0.0', 100], ['1.0.1', 200], ['1.0.2', 300], ['1.0.3', 400], ['1.0.4', 500]],
      }),
    ]);
    const published = kinds(events, 'publish');
    assert.deepEqual(versions(events, 'publish'), ['1.0.0', '1.0.1', '1.0.2', '1.0.3', '1.0.4']);
    // Only the first sighting is history; the rest are news.
    assert.equal(published.filter((e) => e.backfill).length, 1);
    assert.equal(published.find((e) => e.version === '1.0.4')?.at, 500,
      'stamped with npm\'s publish time, not our observation time');
  });

  it('does not re-emit a version that merely aged out of the row window', () => {
    // `times` is a fixed 7-day lookback, so old entries disappear from later
    // observations. That is not an unpublish and must not read as one.
    const events = deriveForPackage([
      obs({ name: 'p', fetchedAt: '2026-08-01T00:00:00.000Z', times: [['1.0.0', 100], ['1.0.1', 200]] }),
      obs({ name: 'p', fetchedAt: '2026-08-09T00:00:00.000Z', revInt: 2, times: [['1.0.1', 200]] }),
    ]);
    assert.equal(kinds(events, 'publish').length, 2, 'both from the first sighting only');
    assert.equal(kinds(events, 'version_unpublish').length, 0);
  });

  it('gives stable ids, so a rebuild produces the same events', () => {
    const rows = [obs({ name: 'p', fetchedAt: '2026-08-01T00:00:00.000Z', times: [['1.0.0', 100]] })];
    assert.deepEqual(deriveForPackage(rows).map((e) => e.id), deriveForPackage(rows).map((e) => e.id));
  });
});

describe('version_unpublish — the malware case', () => {
  it('carries the version\'s ORIGINAL publish time, not the detection time', () => {
    const events = deriveForPackage([
      obs({
        name: 'chalk', fetchedAt: '2026-08-01T00:00:00.000Z',
        times: [['5.6.0', 100], ['5.6.1', 200]], missing: [['5.6.1', 200]], missingCount: 1,
      }),
    ]);
    const yank = kinds(events, 'version_unpublish')[0];
    assert.ok(yank);
    assert.equal(yank.version, '5.6.1');
    assert.equal(yank.at, 200, 'when it existed, which is the half that is hard to recover');
  });

  it('emits once even though the yank stays visible on every later observation', () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      obs({
        name: 'chalk', fetchedAt: `2026-08-0${i + 1}T00:00:00.000Z`, revInt: i + 1,
        times: [['5.6.1', 200]], missing: [['5.6.1', 200]], missingCount: 1,
      }),
    );
    const ids = new Set(kinds(deriveForPackage(rows), 'version_unpublish').map((e) => e.id));
    assert.equal(ids.size, 1, 'deduped by id, so the index dedupes for free');
  });
});

describe('package_unpublish — the graveyard', () => {
  it('reports age at death and who was maintaining it', () => {
    const created = 1_700_000_000;
    const died = created + 90 * 86_400;
    const events = deriveForPackage([
      obs({
        name: 'dead-thing', fetchedAt: '2026-08-01T00:00:00.000Z', tombstone: true,
        created, unpublishedAt: died, unpublishedBy: 'someuser',
        unpublishedVersions: ['1.0.0'], maintainers: ['someuser'],
      }),
    ]);
    const death = kinds(events, 'package_unpublish')[0];
    assert.ok(death);
    assert.equal(death.at, died, 'time.unpublished.time, never time.modified');
    assert.equal(death.detail['ageAtDeathDays'], 90);
    assert.deepEqual(death.detail['maintainers'], ['someuser']);
  });

  it('does NOT report an ancient death as news each time the feed re-emits it', () => {
    // The nethix case: died 2022-03-11, resurfaced as a deleted:true feed row in
    // 2026-08. Without keying on the death time, the graveyard would announce it
    // again on every resurfacing — permanently, because the archive is append-only.
    const died = Math.floor(Date.parse('2022-03-11T21:21:03Z') / 1000);
    const rows = ['2026-08-01', '2026-08-02', '2026-08-03'].map((d, i) =>
      obs({
        name: 'nethix', fetchedAt: `${d}T00:00:00.000Z`, revInt: 20 + i,
        tombstone: true, unpublishedAt: died, created: died - 86_400,
      }),
    );
    const deaths = kinds(deriveForPackage(rows), 'package_unpublish');
    assert.equal(new Set(deaths.map((e) => e.id)).size, 1, 'one death, however often it resurfaces');
    assert.ok((deaths[0]!.detail['noticedAfterDays'] as number) > 1500,
      'and the row says plainly how stale the news is');
  });

  it('matches the real nethix fixture end to end', () => {
    // Guards against the trap directly: time.modified is 2026-08-01 but the
    // package actually died in 2022.
    const doc = packument('nethix');
    const observation = buildObservation({
      runId: 'r1',
      row: { seq: 1, id: 'nethix', changes: [{ rev: '22-x' }], deleted: true },
      result: { outcome: 'tombstone', status: 200, doc, raw: null, etag: null, bytes: 0, error: null },
      now: new Date('2026-08-03T00:00:00Z'),
      packumentKey: null,
    });
    const death = kinds(deriveForPackage([observation]), 'package_unpublish')[0];
    assert.ok(death);
    assert.equal(new Date(death.at * 1000).getUTCFullYear(), 2022);
    assert.equal(kinds(deriveForPackage([observation]), 'version_unpublish').length, 0,
      'a tombstone is one death, not nineteen version yanks');
  });
});

describe('maintainer_change and rev_gap', () => {
  it('flags a change of maintainer set', () => {
    const events = deriveForPackage([
      obs({ name: 'p', fetchedAt: '2026-08-01T00:00:00.000Z', maintainers: ['alice'], maintainerHashes: ['h:1'] }),
      obs({ name: 'p', fetchedAt: '2026-08-02T00:00:00.000Z', revInt: 2, maintainers: ['mallory'], maintainerHashes: ['h:2'] }),
    ]);
    const change = kinds(events, 'maintainer_change')[0];
    assert.ok(change);
    assert.deepEqual(change.detail['fromLogins'], ['alice']);
    assert.deepEqual(change.detail['toLogins'], ['mallory']);
  });

  it('stays quiet when the maintainer set is unchanged', () => {
    const events = deriveForPackage([
      obs({ name: 'p', fetchedAt: '2026-08-01T00:00:00.000Z', maintainerHashes: ['h:1'] }),
      obs({ name: 'p', fetchedAt: '2026-08-02T00:00:00.000Z', revInt: 2, maintainerHashes: ['h:1'] }),
    ]);
    assert.equal(kinds(events, 'maintainer_change').length, 0);
  });

  it('flags unexplained revisions — the only trace of unpublish-then-republish', () => {
    const events = deriveForPackage([
      obs({ name: 'p', fetchedAt: '2026-08-01T00:00:00.000Z', revInt: 5 }),
      obs({ name: 'p', fetchedAt: '2026-08-02T00:00:00.000Z', revInt: 9 }),
    ]);
    const gapEvent = kinds(events, 'rev_gap')[0];
    assert.ok(gapEvent);
    assert.equal(gapEvent.detail['unexplained'], 3);
  });

  it('does not flag a single ordinary revision bump', () => {
    const events = deriveForPackage([
      obs({ name: 'p', fetchedAt: '2026-08-01T00:00:00.000Z', revInt: 5 }),
      obs({ name: 'p', fetchedAt: '2026-08-02T00:00:00.000Z', revInt: 6 }),
    ]);
    assert.equal(kinds(events, 'rev_gap').length, 0);
  });
});

describe('gone', () => {
  it('records a 404 once per observed revision', () => {
    const events = deriveForPackage([
      obs({ name: 'purged', fetchedAt: '2026-08-01T00:00:00.000Z', outcome: 'gone', status: 404, rev: '3-a' }),
      obs({ name: 'purged', fetchedAt: '2026-08-02T00:00:00.000Z', outcome: 'gone', status: 404, rev: '3-a' }),
    ]);
    assert.equal(new Set(kinds(events, 'gone').map((e) => e.id)).size, 1);
  });
});

describe('deriveAll', () => {
  it('groups by package and orders each group chronologically', () => {
    // Deliberately interleaved and out of order, as a shard scan would deliver them.
    const events = deriveAll([
      obs({ name: 'b', fetchedAt: '2026-08-02T00:00:00.000Z', revInt: 2, times: [['2.0.0', 2]] }),
      obs({ name: 'a', fetchedAt: '2026-08-02T00:00:00.000Z', revInt: 2, times: [['1.0.0', 1], ['1.1.0', 3]] }),
      obs({ name: 'a', fetchedAt: '2026-08-01T00:00:00.000Z', times: [['1.0.0', 1]] }),
    ]);
    const aPublishes = events.filter((e) => e.name === 'a' && e.kind === 'publish');
    assert.deepEqual(aPublishes.map((e) => e.version), ['1.0.0', '1.1.0']);
    assert.equal(aPublishes.find((e) => e.version === '1.0.0')?.backfill, true, 'first sighting');
    assert.equal(aPublishes.find((e) => e.version === '1.1.0')?.backfill, false, 'genuinely new');
  });
});

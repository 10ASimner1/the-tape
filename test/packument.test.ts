import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import * as p from '../src/packument.ts';
import { setSaltForTesting } from '../src/pii.ts';
import { packument, SCOPED_OPENPOND, SCOPED_TINYCOLOR } from './fixtures.ts';

setSaltForTesting('test-salt-0123456789abcdef');

const names = (vts: readonly p.VersionTime[]): string[] => vts.map(([v]) => v).sort();

describe('missingVersions — per-version unpublish, the malware case', () => {
  // These are the versions that were yanked in real supply-chain incidents.
  // None of them sets `time.unpublished`; the set difference is the only signal.
  const cases: Array<[fixture: string, expected: string[]]> = [
    ['chalk', ['5.6.1']],
    ['debug', ['4.4.2']],
    ['event-stream', ['3.3.6']],
    ['ua-parser-js', ['0.7.29', '0.8.0', '1.0.0']],
    ['coa', ['2.0.3', '2.0.4', '2.1.1', '2.1.3', '3.0.1', '3.1.3']],
    ['rc', ['1.2.9', '1.3.9', '2.3.9']],
    [SCOPED_TINYCOLOR, ['4.1.1', '4.1.2']],
    ['flatmap-stream', ['11.1.1']],
  ];

  for (const [fixture, expected] of cases) {
    it(`${fixture} → ${expected.join(', ')}`, () => {
      const doc = packument(fixture);
      assert.deepEqual(names(p.missingVersions(doc)), expected);
      // The spec's original rule would have found none of these.
      assert.equal(p.unpublishInfo(doc), null, 'no time.unpublished is set for a version yank');
    });
  }

  it('carries the ORIGINAL publish timestamp, not the detection time', () => {
    // Without this, the archive records that a version vanished but not when it
    // existed — and for a yanked malware version that is the interesting half.
    const [entry] = p.missingVersions(packument('event-stream'));
    assert.ok(entry);
    assert.equal(entry[0], '3.3.6');
    assert.equal(entry[1], 1536481739); // 2018-09-09, when it was published
  });

  it('is silent on clean packages', () => {
    for (const clean of ['left-pad', 'lodash', 'compresion']) {
      assert.deepEqual(p.missingVersions(packument(clean)), [], `${clean} should be clean`);
    }
  });

  it('is silent on tombstones — a dead package is ONE event, not N', () => {
    // A tombstone has an empty `versions` map, so every version it ever had would
    // otherwise report as missing. nethix would emit 19 spurious version_unpublish
    // rows on top of its single real package_unpublish.
    for (const tomb of ['nethix', 'glace-tpl', 'claude-profile-switcher', SCOPED_OPENPOND]) {
      assert.deepEqual(p.missingVersions(packument(tomb)), [], `${tomb} is a tombstone`);
    }
  });
});

describe('isTombstone — a dead package returns HTTP 200, not 404', () => {
  it('detects tombstones', () => {
    for (const t of ['nethix', 'glace-tpl', 'tr-config', 'cjhooker-test',
                     'claude-profile-switcher', SCOPED_OPENPOND]) {
      assert.equal(p.isTombstone(packument(t)), true, t);
    }
  });

  it('does not fire on live packages, including ones with yanked versions', () => {
    for (const live of ['left-pad', 'lodash', 'chalk', 'event-stream', 'crossenv']) {
      assert.equal(p.isTombstone(packument(live)), false, live);
    }
  });
});

describe('unpublishInfo — both live shapes', () => {
  it('parses the legacy 5-key shape and recovers the unpublishing USER', () => {
    // ~28% of historical tombstones use this shape. `name` here is an npm
    // username, not the package name — cjhooker-test was unpublished by cjhooker.
    const u = p.unpublishInfo(packument('cjhooker-test'));
    assert.ok(u);
    assert.equal(u.by, 'cjhooker');
    assert.deepEqual(u.versions, ['0.0.1']);

    const t = p.unpublishInfo(packument('tr-config'));
    assert.equal(t?.by, 'sameidtr');
  });

  it('parses the modern 2-key shape, where the actor is unknown', () => {
    const u = p.unpublishInfo(packument('glace-tpl'));
    assert.ok(u);
    assert.equal(u.by, null);
    assert.deepEqual(u.versions, ['0.0.1']);
  });

  it('takes the time from time.unpublished, never from time.modified', () => {
    // The trap: the feed re-emits ancient deletions. nethix appeared as a fresh
    // deleted:true row in 2026-08 with time.modified rewritten to match — but it
    // actually died in 2022. Stamping the event with `modified` would headline a
    // four-year-old unpublish as today's news, permanently.
    const doc = packument('nethix');
    const u = p.unpublishInfo(doc);
    assert.ok(u);
    assert.equal(u.at, 1647033663); // 2022-03-11
    assert.equal(p.modified(doc), 1785590420); // 2026-08-01
    assert.ok(p.modified(doc)! - u.at > 4 * 365 * 24 * 3600, 'four years apart');
  });

  it('returns null for live packages', () => {
    assert.equal(p.unpublishInfo(packument('lodash')), null);
  });
});

describe('securityHolder — conjunction, never a single signal', () => {
  it('confirms genuine npm holders', () => {
    assert.equal(p.securityHolder(packument('flatmap-stream')), 'confirmed');
    assert.equal(p.securityHolder(packument('crossenv')), 'confirmed');
  });

  it('does not fire on an npm-maintained package that keeps real content', () => {
    // `compresion` is maintained by npm@npmjs.com but is a normal typo-takeover
    // with ordinary content. A `maintainers == npm` rule alone would flag 1,624
    // packages like this one.
    const doc = packument('compresion');
    assert.deepEqual(p.maintainerLogins(doc), ['npm']);
    assert.equal(p.securityHolder(doc), null);
  });

  it('does not fire on ordinary packages', () => {
    assert.equal(p.securityHolder(packument('left-pad')), null);
    assert.equal(p.securityHolder(packument('lodash')), null);
  });
});

describe('allVersionTimes / cappedVersionTimes', () => {
  it('excludes the three reserved keys and keeps every version', () => {
    const doc = packument('left-pad');
    const vts = p.allVersionTimes(doc);
    assert.equal(vts.length, 15);
    for (const key of ['created', 'modified', 'unpublished']) {
      assert.ok(!vts.some(([v]) => v === key), `${key} must not be treated as a version`);
    }
  });

  it('returns entries sorted oldest-first', () => {
    const vts = p.allVersionTimes(packument('lodash'));
    for (let i = 1; i < vts.length; i++) assert.ok(vts[i]![1] >= vts[i - 1]![1]);
  });

  it('keeps a tombstone\'s history — the versions it had before it died', () => {
    // The `versions` map is gone but `time` retains every original publish
    // instant, so the graveyard entry can still report the package's age.
    const vts = p.allVersionTimes(packument('nethix'));
    assert.equal(vts.length, 19);
    assert.ok(p.created(packument('nethix')));
  });

  it('bounds the row by a FIXED window, so a fetch backlog cannot outrun it', () => {
    // The window is measured from the moment of observation, not from a watermark
    // that advances with runs. A packument fetched seven hours late gets exactly
    // the same history as one fetched on time — that property is why deferrals
    // and multi-day backlogs are harmless here.
    const doc = packument('lodash');
    const all = p.allVersionTimes(doc);
    const newestTime = all.at(-1)![1];

    const atPublish = p.cappedVersionTimes(doc, (newestTime + 60) * 1000);
    const sevenHoursLate = p.cappedVersionTimes(doc, (newestTime + 60 + 7 * 3600) * 1000);
    assert.deepEqual(atPublish, sevenHoursLate);
    assert.ok(atPublish.length > 0 && atPublish.length < all.length, 'windowed, not everything');

    // Long after the last release, nothing is recent — but versionCount and
    // versionsDigest still pin the full set on every row.
    assert.deepEqual(p.cappedVersionTimes(doc, Date.now()), []);
  });

  it('caps a high-churn package, keeping the NEWEST entries', () => {
    // MEASURED on the first live run: @atlassian-test-prod/synth-check carries
    // 22,603 versions, 17,114 of them unpublished. Uncapped that is a 453 KB row.
    const t0 = Math.floor(Date.now() / 1000) - 1000;
    const time: Record<string, string> = { created: '2020-01-01T00:00:00.000Z' };
    const versions: Record<string, unknown> = {};
    for (let i = 0; i < 1000; i++) {
      time[`1.0.${i}`] = new Date((t0 + i) * 1000).toISOString();
      if (i % 2 === 0) versions[`1.0.${i}`] = { name: 'churn', version: `1.0.${i}` };
    }
    const doc = { name: 'churn', time, versions };

    const capped = p.cappedVersionTimes(doc, Date.now());
    assert.equal(capped.length, 100);
    assert.equal(capped.at(-1)![0], '1.0.999', 'the newest version must always survive');

    // The true totals survive truncation, so a churning package cannot understate
    // itself just because its row was capped.
    assert.equal(p.missingVersions(doc).length, 500);
    assert.equal(p.cappedMissingVersions(doc).length, 100);
    assert.equal(p.cappedMissingVersions(doc).at(-1)![0], '1.0.999', 'newest yank survives');

    assert.equal(p.recentVersionCount(doc, Date.now()), 500);
    assert.equal(p.recentVersionDetails(doc, Date.now()).length, 20);
  });
});

describe('revInt — the mutation counter', () => {
  it('extracts the integer prefix', () => {
    assert.equal(p.revInt(packument('lodash')), 3583);
    assert.equal(p.revInt({ _rev: '11-721a2c9f' }), 11);
    assert.equal(p.revInt({ _rev: 'nonsense' }), null);
    assert.equal(p.revInt({}), null);
  });
});

describe('installScripts', () => {
  it('finds the three lifecycle hooks and ignores others', () => {
    assert.deepEqual(
      p.installScripts({ scripts: { postinstall: 'node install.js', test: 'tap' } }),
      ['postinstall'],
    );
    assert.deepEqual(
      p.installScripts({ scripts: { preinstall: 'a', install: 'b', postinstall: 'c' } }),
      ['preinstall', 'install', 'postinstall'],
    );
    assert.deepEqual(p.installScripts({ scripts: { build: 'tsc' } }), []);
    assert.deepEqual(p.installScripts({}), []);
  });
});

describe('resilience to whatever the registry actually sends', () => {
  it('never throws on malformed or empty input', () => {
    for (const junk of [{}, { time: null }, { time: { created: 'not-a-date' } },
                        { versions: 'not-an-object' }, { maintainers: [null, 'x', {}] },
                        { 'dist-tags': { latest: 42 } }]) {
      assert.doesNotThrow(() => {
        p.allVersionTimes(junk);
        p.missingVersions(junk);
        p.unpublishInfo(junk);
        p.securityHolder(junk);
        p.maintainerLogins(junk);
        p.distTags(junk);
        p.recentVersionDetails(junk, Date.now());
      });
    }
  });

  it('handles scoped names, which are 77.5% of live npm activity', () => {
    const doc = packument(SCOPED_TINYCOLOR);
    assert.equal(p.name(doc), '@ctrl/tinycolor');
    assert.deepEqual(names(p.missingVersions(doc)), ['4.1.1', '4.1.2']);
  });
});

describe('recentVersionDetails', () => {
  it('extracts per-version detail for versions inside the lookback window', () => {
    const doc = packument('left-pad');
    const newest = p.allVersionTimes(doc).at(-1)!;
    // Pin "now" just after the newest publish so exactly that version qualifies.
    const details = p.recentVersionDetails(doc, (newest[1] + 60) * 1000);
    assert.equal(details.length, 1);
    const d = details[0]!;
    assert.equal(d.v, newest[0]);
    assert.equal(d.by, 'stevemao');
    assert.equal(d.license, 'WTFPL');
    assert.equal(d.repoHost, 'github.com');
    assert.ok(d.integrity?.startsWith('sha512-'));
    assert.equal(d.fileCount, 10);
    assert.deepEqual(d.installScripts, []);
  });

  it('is a CLOSED interval, so history re-derives identically', () => {
    // With only a lower bound, asking "what was recent as of 2016?" also returned
    // everything published since — which made the answer depend on when you asked.
    // The index re-derives over historical rows, so that has to be stable.
    const doc = packument('debug');
    const at = p.allVersionTimes(doc).find(([v]) => v === '2.4.0');
    assert.ok(at);
    const asOf2016 = p.recentVersionDetails(doc, (at[1] + 60) * 1000);
    assert.ok(asOf2016.some((d) => d.v === '2.4.0'), 'the asked-for version is in the window');
    assert.ok(!asOf2016.some((d) => d.v.startsWith('4.')), 'nothing from years later');
    // The clock-skew tolerance legitimately admits 2.4.1, published minutes after
    // 2.4.0 — hence "critical bug fixed in 2.4.1".
    assert.ok(asOf2016.every((d) => d.t <= at[1] + 3600));
  });

  it('never emits a version that is absent from the versions map', () => {
    // A yanked version is reported by missingVersions, never here — otherwise it
    // would be counted as both a publish and an unpublish in the same run.
    const doc = packument('event-stream');
    const details = p.recentVersionDetails(doc, Date.now());
    assert.ok(!details.some((d) => d.v === '3.3.6'));
  });

  it('reports the deprecation message, not a boolean', () => {
    // The text is the interesting part — "critical bug fixed in 2.4.1" says far
    // more than `deprecated: true` ever could.
    const doc = packument('debug');
    const at = p.allVersionTimes(doc).find(([v]) => v === '2.4.0');
    assert.ok(at, 'fixture has debug@2.4.0');
    // Pin "now" to just after that publish so it falls inside the lookback window.
    const details = p.recentVersionDetails(doc, (at[1] + 60) * 1000);
    const dep = details.find((d) => d.v === '2.4.0');
    assert.ok(dep);
    assert.equal(dep.deprecated, 'critical bug fixed in 2.4.1');
    assert.ok(details.some((d) => d.deprecated === null), 'and null when not deprecated');
  });
});

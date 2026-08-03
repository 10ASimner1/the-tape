import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { createDatabase } from '../src/index/build.ts';
import type { DerivedEvent } from '../src/index/derive.ts';
import { collect, render } from '../src/index/digest.ts';
import { setSaltForTesting } from '../src/pii.ts';

setSaltForTesting('test-salt-0123456789abcdef');

const DAY = '2026-08-03';
const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);

function db() {
  return createDatabase(join(mkdtempSync(join(tmpdir(), 'tape-digest-')), 'i.sqlite'));
}

function insert(d: ReturnType<typeof db>, e: Partial<DerivedEvent> & Pick<DerivedEvent, 'id' | 'kind' | 'name' | 'at'>) {
  d.prepare(
    `INSERT OR IGNORE INTO events (id, kind, name, version, at, observed_at, run_id, seq, backfill, detail)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    e.id, e.kind, e.name, e.version ?? null, e.at,
    e.observedAt ?? `${DAY}T12:00:00.000Z`, e.runId ?? 'r1', e.seq ?? 1,
    e.backfill === false ? 0 : 1, JSON.stringify(e.detail ?? {}),
  );
}

describe('a single-observation package still reaches the digest', () => {
  it('counts a first-sighting publish that happened today', () => {
    // The bug this guards: `backfill` marks PROVENANCE (this came from a first
    // sighting), and it was being used as a recency filter. A typosquat publishes
    // one version, is observed once, and is never seen again — so its only publish
    // event is permanently backfilled. Filtering those out emptied the two
    // malware-facing sections of the public digest entirely.
    const d = db();
    insert(d, {
      id: 'publish|@types/reakt|1.0.0', kind: 'publish', name: '@types/reakt',
      version: '1.0.0', at: at(`${DAY}T10:00:00Z`), backfill: true,
      detail: { isNewPackage: true, installScripts: ['postinstall'] },
    });
    d.prepare(`INSERT INTO typosquat (name, score, nearest) VALUES (?,?,?)`).run(
      '@types/reakt', 0.95, JSON.stringify([{ target: '@types/react', distance: 1 }]),
    );

    const digest = collect(d, DAY);
    assert.equal(digest.totals.publishes, 1);
    assert.equal(digest.totals.newPackages, 1);
    assert.equal(digest.typosquats.length, 1, 'the watchlist must not be structurally empty');
    assert.equal(digest.typosquats[0]?.name, '@types/reakt');
    assert.equal(digest.installScripts.length, 1);
  });

  it('still excludes a first sighting whose versions were published long ago', () => {
    // The `at` bound is what separates history from news — `at` is npm's own
    // publish time, so this needs no help from `backfill`.
    const d = db();
    insert(d, {
      id: 'publish|old-pkg|1.0.0', kind: 'publish', name: 'old-pkg',
      version: '1.0.0', at: at('2019-01-01T00:00:00Z'), backfill: true,
    });
    assert.equal(collect(d, DAY).totals.publishes, 0);
  });
});

describe('the headline agrees with the table beneath it', () => {
  it('counts yanks by when we SAW them, not when the version was published', () => {
    // A version_unpublish carries the version's ORIGINAL publish time, because npm
    // records no yank timestamp. Counting on that made the headline read
    // "0 versions yanked" directly above a table listing them — published nightly
    // to a public repo.
    const d = db();
    insert(d, {
      id: 'vunpub|evil|1.2.3', kind: 'version_unpublish', name: 'evil', version: '1.2.3',
      at: at('2025-06-01T00:00:00Z'), observedAt: `${DAY}T09:00:00.000Z`, backfill: false,
    });

    const digest = collect(d, DAY);
    assert.equal(digest.totals.versionUnpublishes, 1, 'headline');
    assert.equal(digest.versionYanks.length, 1, 'table');
    assert.equal(digest.versionYanks[0]?.name, 'evil');

    const { markdown } = render(digest);
    assert.match(markdown, /1 version yanked/);
    assert.match(markdown, /`evil`/);
  });
});

describe('the graveyard', () => {
  it('separates a death that happened today from one the feed merely resurfaced', () => {
    const d = db();
    insert(d, {
      id: 'punpub|died-today|1', kind: 'package_unpublish', name: 'died-today',
      at: at(`${DAY}T08:00:00Z`), backfill: false,
      detail: { ageAtDeathDays: 3, versions: ['1.0.0'], maintainers: ['someone'] },
    });
    insert(d, {
      id: 'punpub|nethix|2', kind: 'package_unpublish', name: 'nethix',
      at: at('2022-03-11T21:21:03Z'), observedAt: `${DAY}T08:00:00.000Z`, backfill: false,
      detail: { ageAtDeathDays: 400, versions: [], maintainers: [] },
    });

    const digest = collect(d, DAY);
    assert.deepEqual(digest.graveyard.map((g) => g.name), ['died-today']);
    assert.deepEqual(digest.resurfaced.map((g) => g.name), ['nethix']);
    assert.equal(digest.totals.packageUnpublishes, 1, 'ancient deaths are not today\'s news');

    const { markdown } = render(digest);
    assert.match(markdown, /From the vault/);
  });
});

describe('the digest never publishes contact details', () => {
  it('scrubs an address out of a third-party OSV summary', () => {
    // OSV records really do carry addresses (the amazon-inspector source puts one
    // in credits[].contact). Projecting here means the strict gate is a tripwire
    // rather than the only thing between an upstream field and a public commit.
    const d = db();
    d.prepare(
      `INSERT INTO osv_records (id, modified, summary, is_malicious) VALUES (?,?,?,1)`,
    ).run('MAL-2026-1', `${DAY}T09:00:00Z`, 'Report issues to researcher@example.com now');
    d.prepare(`INSERT INTO osv_affects (osv_id, name, version, basis) VALUES (?,?,?,?)`)
      .run('MAL-2026-1', 'evil-pkg', null, 'unknown');

    const digest = collect(d, DAY);
    assert.ok(!digest.malicious[0]?.summary?.includes('@example.com'));
    assert.match(digest.malicious[0]!.summary!, /address removed/);
    assert.doesNotThrow(() => render(digest), 'and the gate accepts the scrubbed result');
  });

  it('renders an empty day without throwing', () => {
    const { markdown } = render(collect(db(), DAY));
    assert.match(markdown, /No packages died today/);
  });
});

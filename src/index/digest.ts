/**
 * The daily digest — the public face of the archive.
 *
 * The graveyard is the headline, because it is the section nobody else on the
 * internet has: which packages died, at what age, and under whose maintainership.
 *
 * Two rules govern everything here.
 *
 * First, npm USERNAMES only. Never an email, never a residual unpublish payload.
 * People sometimes unpublish precisely because they published something they
 * should not have; we may lawfully hold the public record, but we do not
 * republish what someone deliberately removed. Every byte written by this module
 * goes through the strict PII gate, which refuses even a field NAMED like contact
 * data.
 *
 * Second, a package's first sighting reports its whole history at once. That is
 * history, not news — so backfilled events never count toward a day's totals, and
 * an ancient death the feed happens to resurface is reported separately from a
 * package that actually died today.
 */

import type { DatabaseSync } from 'node:sqlite';

import { assertNoPII, EMAIL_RE } from '../pii.ts';

/**
 * OSV summaries are the only third-party free text that reaches the digest, and
 * OSV records really do carry addresses (the amazon-inspector source puts one in
 * `credits[].contact`). Projecting here means the strict gate is a tripwire rather
 * than the thing standing between an upstream field and a public commit.
 */
const scrubText = (s: string | null): string | null =>
  s === null ? null : s.replace(new RegExp(EMAIL_RE.source, 'g'), '[address removed]');

export type GraveyardEntry = {
  readonly name: string;
  readonly diedAt: string;
  readonly ageAtDeathDays: number | null;
  readonly versionsLost: number;
  /** npm usernames. Never contact details. */
  readonly maintainers: string[];
  readonly unpublishedBy: string | null;
};

export type DigestData = {
  readonly date: string;
  readonly generatedAt: string;
  readonly totals: {
    readonly packagesObserved: number;
    readonly publishes: number;
    readonly newPackages: number;
    readonly packageUnpublishes: number;
    readonly versionUnpublishes: number;
    readonly maintainerChanges: number;
    readonly revGaps: number;
    readonly gone: number;
  };
  readonly graveyard: GraveyardEntry[];
  /** Deaths recorded today that actually happened before today. */
  readonly resurfaced: GraveyardEntry[];
  /** Grouped by package: two CI bots yanking their own churn would otherwise fill
   *  the whole section and bury the handful of yanks that mean something. */
  readonly versionYanks: Array<{
    name: string; versions: string[]; count: number; oldest: string;
  }>;
  readonly typosquats: Array<{ name: string; score: number; nearest: string; distance: number }>;
  readonly malicious: Array<{ osvId: string; name: string; summary: string | null }>;
  readonly installScripts: Array<{ name: string; version: string; scripts: string[] }>;
  readonly ops: {
    readonly observations: number;
    readonly gaps: number;
    readonly piiRefused: number;
    readonly securityHolders: number;
  };
};

const dayBounds = (date: string): [number, number] => {
  const start = Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000);
  return [start, start + 86_400];
};

type EventRow = {
  name: string; version: string | null; at: number; observed_at: string;
  detail: string; backfill: number;
};

function toGraveyard(rows: EventRow[]): GraveyardEntry[] {
  return rows.map((r) => {
    const d = JSON.parse(r.detail) as Record<string, unknown>;
    return {
      name: r.name,
      diedAt: new Date(r.at * 1000).toISOString(),
      ageAtDeathDays: (d['ageAtDeathDays'] as number | null) ?? null,
      versionsLost: Array.isArray(d['versions']) ? (d['versions'] as unknown[]).length : 0,
      maintainers: Array.isArray(d['maintainers']) ? (d['maintainers'] as string[]) : [],
      unpublishedBy: (d['by'] as string | null) ?? null,
    };
  });
}

export function collect(db: DatabaseSync, date: string): DigestData {
  const [from, to] = dayBounds(date);
  const observedToday = `${date}T00:00:00.000Z`;
  const observedTomorrow = `${date}T23:59:59.999Z`;

  /**
   * Counts by EVENT time, which for a publish is npm's own timestamp.
   *
   * Deliberately no `backfill = 0` here. `backfill` marks provenance — this event
   * came from a first sighting — and using it as a recency filter deleted almost
   * every brand-new package from the digest: a typosquat publishes one version, is
   * observed once, and is never seen again, so its only publish event is
   * permanently backfilled. The `at` bound already separates history from news.
   */
  const count = (kind: string): number =>
    (
      db
        .prepare(`SELECT COUNT(*) AS n FROM events WHERE kind = ? AND at >= ? AND at < ?`)
        .get(kind, from, to) as { n: number }
    ).n;

  /**
   * Yanks are counted by when we SAW them, AND excluding first sightings.
   *
   * Both halves are needed, and shipping only the first published a figure that
   * was wrong by 43x. A yank's `at` is the version's ORIGINAL publish time, often
   * years earlier, so counting on `at` made the headline say "0 versions yanked"
   * directly above a table listing them — hence `observed_at`. But `observed_at`
   * alone counts a package's ENTIRE yank history the first time we see it: of the
   * 3,425 reported for 2026-08-03, 3,345 were first sightings, 35 of them dating
   * to 2014. The honest same-day figure was 80.
   *
   * Note this is the exact opposite of the rule for `count()` above, which
   * deliberately does NOT filter on backfill — and the reasoning does not
   * transfer between them. There, `at` is a real publish timestamp doing the
   * recency work, and excluding backfill would delete every typosquat (published
   * once, observed once, so permanently backfilled). Here `at` cannot do that
   * work, so backfill is the only recency signal left. Each decision was sound;
   * what was missing was checking them against each other.
   */
  const countObservedFresh = (kind: string): number =>
    (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM events
            WHERE kind = ? AND observed_at >= ? AND observed_at <= ? AND backfill = 0`,
        )
        .get(kind, observedToday, observedTomorrow) as { n: number }
    ).n;

  // Died today.
  const graveyard = toGraveyard(
    db
      .prepare(
        `SELECT name, version, at, observed_at, detail, backfill FROM events
          WHERE kind = 'package_unpublish' AND at >= ? AND at < ?
          ORDER BY at DESC`,
      )
      .all(from, to) as EventRow[],
  );

  // Recorded today, died earlier. The feed re-emits ancient deletions, so this is
  // a real and recurring category — and reporting it as today's news would be a lie.
  const resurfaced = toGraveyard(
    db
      .prepare(
        `SELECT name, version, at, observed_at, detail, backfill FROM events
          WHERE kind = 'package_unpublish' AND at < ?
            AND observed_at >= ? AND observed_at <= ?
          ORDER BY at DESC LIMIT 25`,
      )
      .all(from, observedToday, observedTomorrow) as EventRow[],
  );

  // Grouped, and ordered by fewest-first. A package yanking three versions is a
  // story; a release bot yanking four hundred is a fact about the bot, and on the
  // first real run two Atlassian test packages produced 46 of the top 50 rows.
  //
  // The backfill filter below fixes a different half of that same problem: those
  // 46 rows were a first sighting reporting years of history at once. Ordering
  // handles noisy bots, the filter handles history — they are not substitutes,
  // and the ordering rationale above still holds with the filter in place.
  const versionYanks = (
    db
      .prepare(
        `SELECT name, COUNT(*) AS count, MIN(at) AS oldest,
                GROUP_CONCAT(version) AS versions
           FROM events
          WHERE kind = 'version_unpublish'
            AND observed_at >= ? AND observed_at <= ?
            -- Same rule as the headline count, for the same reason: without it
            -- this table is a sample of packages' whole yank histories rather
            -- than of today's, and the two disagreeing is worse than either.
            AND backfill = 0
          GROUP BY name
          ORDER BY count ASC, oldest ASC
          LIMIT 25`,
      )
      .all(observedToday, observedTomorrow) as Array<{
        name: string; count: number; oldest: number; versions: string;
      }>
  ).map((r) => ({
    name: r.name,
    versions: r.versions.split(',').slice(0, 5),
    count: r.count,
    oldest: new Date(r.oldest * 1000).toISOString(),
  }));

  const typosquats = (
    db
      .prepare(
        `SELECT t.name, t.score, t.nearest FROM typosquat t
           JOIN events e ON e.name = t.name AND e.kind = 'publish'
          WHERE e.at >= ? AND e.at < ?
          GROUP BY t.name
          ORDER BY t.score DESC LIMIT 10`,
      )
      .all(from, to) as Array<{ name: string; score: number; nearest: string }>
  ).map((r) => {
    const nearest = JSON.parse(r.nearest) as Array<{ target: string; distance: number }>;
    return {
      name: r.name, score: r.score,
      nearest: nearest[0]?.target ?? '', distance: nearest[0]?.distance ?? 0,
    };
  });

  const malicious = db
    .prepare(
      `SELECT DISTINCT r.id AS osvId, a.name, r.summary FROM osv_records r
         JOIN osv_affects a ON a.osv_id = r.id
        WHERE r.is_malicious = 1 AND r.modified >= ? AND r.modified <= ?
        ORDER BY r.modified DESC LIMIT 50`,
    )
    .all(observedToday, observedTomorrow) as Array<{
      osvId: string; name: string; summary: string | null;
    }>;
  const maliciousScrubbed = malicious.map((m) => ({ ...m, summary: scrubText(m.summary) }));

  const installScripts = (
    db
      .prepare(
        `SELECT name, version, detail FROM events
          WHERE kind = 'publish' AND at >= ? AND at < ?
            AND detail LIKE '%"installScripts":["%'
          ORDER BY at DESC LIMIT 25`,
      )
      .all(from, to) as Array<{ name: string; version: string; detail: string }>
  ).map((r) => ({
    name: r.name, version: r.version,
    scripts: (JSON.parse(r.detail) as { installScripts?: string[] }).installScripts ?? [],
  }));

  const scalar = (sql: string, ...args: unknown[]): number =>
    (db.prepare(sql).get(...(args as never[])) as { n: number }).n;

  return {
    date,
    generatedAt: new Date().toISOString(),
    totals: {
      packagesObserved: scalar(
        `SELECT COUNT(DISTINCT name) AS n FROM observations WHERE fetched_at >= ? AND fetched_at <= ?`,
        observedToday, observedTomorrow,
      ),
      publishes: count('publish'),
      newPackages: scalar(
        `SELECT COUNT(*) AS n FROM events
          WHERE kind = 'publish' AND at >= ? AND at < ?
            AND detail LIKE '%"isNewPackage":true%'`,
        from, to,
      ),
      packageUnpublishes: graveyard.length,
      versionUnpublishes: countObservedFresh('version_unpublish'),
      maintainerChanges: count('maintainer_change'),
      revGaps: count('rev_gap'),
      gone: count('gone'),
    },
    graveyard,
    resurfaced,
    versionYanks,
    typosquats,
    malicious: maliciousScrubbed,
    installScripts,
    ops: {
      observations: scalar(
        `SELECT COUNT(*) AS n FROM observations WHERE fetched_at >= ? AND fetched_at <= ?`,
        observedToday, observedTomorrow,
      ),
      gaps: scalar(`SELECT COUNT(*) AS n FROM gaps WHERE at >= ? AND at <= ?`,
        observedToday, observedTomorrow),
      piiRefused: scalar(
        `SELECT COUNT(*) AS n FROM gaps WHERE kind = 'pii_refused' AND at >= ? AND at <= ?`,
        observedToday, observedTomorrow),
      securityHolders: scalar(`SELECT COUNT(*) AS n FROM packages WHERE security_holder IS NOT NULL`),
    },
  };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function renderMarkdown(d: DigestData): string {
  const L: string[] = [];
  L.push(`# The Tape — ${d.date}`, '');
  L.push(
    `${plural(d.totals.packagesObserved, 'package')} observed · ` +
      `${plural(d.totals.publishes, 'publish', 'publishes')} · ` +
      `${plural(d.totals.newPackages, 'new package')} · ` +
      `**${plural(d.totals.packageUnpublishes, 'package')} died** · ` +
      `${plural(d.totals.versionUnpublishes, 'version')} yanked`,
    '',
  );

  L.push('## 🪦 The graveyard', '');
  if (d.graveyard.length === 0) {
    L.push('_No packages died today._', '');
  } else {
    L.push('| package | age at death | versions lost | maintainers |', '|---|---|---|---|');
    for (const g of d.graveyard) {
      const age = g.ageAtDeathDays === null ? '—'
        : g.ageAtDeathDays < 1 ? 'under a day'
        : plural(g.ageAtDeathDays, 'day');
      L.push(`| \`${g.name}\` | ${age} | ${g.versionsLost} | ${g.maintainers.join(', ') || '—'} |`);
    }
    L.push('');
  }

  if (d.resurfaced.length > 0) {
    L.push('### From the vault', '');
    L.push(
      '_Deaths recorded today that happened earlier — npm\'s changes feed re-emits ' +
        'old deletions, so these are not today\'s news._',
      '',
    );
    L.push('| package | died |', '|---|---|');
    for (const g of d.resurfaced) L.push(`| \`${g.name}\` | ${g.diedAt.slice(0, 10)} |`);
    L.push('');
  }

  L.push('## Versions yanked', '');
  if (d.versionYanks.length === 0) L.push('_None._', '');
  else {
    L.push(
      '_A version removed while the package lives on. This is the shape a malware ' +
        'takedown usually has, and npm records nothing to mark it._',
      '',
    );
    L.push('| package | versions | oldest |', '|---|---|---|');
    for (const y of d.versionYanks) {
      const shown = y.versions.map((v) => `\`${v}\``).join(', ');
      const more = y.count > y.versions.length ? ` _+${y.count - y.versions.length} more_` : '';
      L.push(`| \`${y.name}\` | ${shown}${more} | ${y.oldest.slice(0, 10)} |`);
    }
    L.push('');
  }

  L.push('## Typosquat watchlist', '');
  if (d.typosquats.length === 0) L.push('_Nothing close to a popular name today._', '');
  else {
    L.push('_A signal, not a verdict — plenty of honest packages sit one edit from a popular one._', '');
    L.push('| new package | looks like | distance | score |', '|---|---|---|---|');
    for (const t of d.typosquats) {
      L.push(`| \`${t.name}\` | \`${t.nearest}\` | ${t.distance} | ${t.score.toFixed(2)} |`);
    }
    L.push('');
  }

  if (d.malicious.length > 0) {
    L.push('## Known-malicious (OSV)', '');
    L.push('| package | advisory | summary |', '|---|---|---|');
    for (const m of d.malicious) {
      L.push(`| \`${m.name}\` | ${m.osvId} | ${(m.summary ?? '').slice(0, 80)} |`);
    }
    L.push('');
  }

  if (d.installScripts.length > 0) {
    L.push('## Published with install scripts', '');
    L.push('_The classic malware vector, and also completely ordinary. Flag only._', '');
    L.push('| package | version | scripts |', '|---|---|---|');
    for (const s of d.installScripts) {
      L.push(`| \`${s.name}\` | \`${s.version}\` | ${s.scripts.join(', ')} |`);
    }
    L.push('');
  }

  L.push('## Ops', '');
  L.push(
    `${d.ops.observations} observations · ${d.ops.gaps} gaps recorded · ` +
      `${d.ops.piiRefused} PII refusals · ${d.ops.securityHolders} security-holding packages known`,
    '',
    `_Maintainers are npm usernames. This archive holds no email addresses._`,
  );

  return L.join('\n') + '\n';
}

export type RenderedDigest = { readonly markdown: string; readonly json: string };

/** Renders and gates. Nothing leaves this module without passing the strict check. */
export function render(data: DigestData): RenderedDigest {
  const markdown = renderMarkdown(data);
  const json = `${JSON.stringify(data, null, 2)}\n`;
  assertNoPII(markdown, `digest:${data.date}.md`);
  assertNoPII(json, `digest:${data.date}.json`);
  return { markdown, json };
}

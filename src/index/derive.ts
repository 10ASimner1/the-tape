/**
 * Turning observations into events.
 *
 * This is the heart of the index and the reason the observation row was made
 * ABSOLUTE rather than relative. Each row records what the packument said, not a
 * diff against something the recorder remembered — so the derivation happens here,
 * offline, with every prior observation of the package in hand. That is what makes
 * the index genuinely disposable: delete it, run this again, get the same events.
 *
 * Pure functions, no I/O. Every rule below is a rule the recorder deliberately
 * does NOT apply at write time.
 *
 * Event ids are canonical and stable, so re-running over the same observations
 * produces the same ids and the index can dedupe with INSERT OR IGNORE. Several
 * rules depend on that: the changes feed re-emits ancient deletions, and a package
 * can legitimately be observed many times without anything having happened.
 */

import type { Observation } from '../observation.ts';

export type EventKind =
  | 'publish'
  | 'version_unpublish'
  | 'package_unpublish'
  | 'gone'
  | 'maintainer_change'
  | 'rev_gap';

export type DerivedEvent = {
  /** Canonical and stable — the index's primary key, so dedupe is free. */
  readonly id: string;
  readonly kind: EventKind;
  readonly name: string;
  readonly version: string | null;
  /** When the event actually happened, epoch seconds. For an unpublish this is
   *  npm's own timestamp, NOT when we noticed. */
  readonly at: number;
  /** When we observed it. The gap between these two is often the story. */
  readonly observedAt: string;
  readonly runId: string;
  readonly seq: number;
  /**
   * True when the event was inferred from a package's FIRST observation rather
   * than from a diff against a previous one.
   *
   * A first sighting reports everything in the packument's time map at once,
   * which is history, not news. Marking it keeps provenance from blurring — the
   * digest can report "3 packages died today" without counting a decade of
   * history we happened to load this morning.
   */
  readonly backfill: boolean;
  readonly detail: Record<string, unknown>;
};

const versionsOf = (obs: Observation): Set<string> => new Set(obs.times.map(([v]) => v));

/**
 * Derives every event for ONE package from its observations in chronological order.
 *
 * Ordering is the caller's responsibility and it matters: these rules compare each
 * observation against the one before it.
 */
export function deriveForPackage(observations: readonly Observation[]): DerivedEvent[] {
  const events: DerivedEvent[] = [];
  let previous: Observation | null = null;
  for (const obs of observations) {
    events.push(...deriveStep(previous, obs));
    previous = obs;
  }
  return events;
}

/**
 * One observation against the one before it.
 *
 * Every rule here compares against the IMMEDIATELY previous observation, never
 * against all history — which is what lets a full rebuild stream the archive
 * while holding only one prior row per package, instead of loading years of
 * observations into memory.
 */
export function deriveStep(
  previous: Observation | null,
  obs: Observation,
): DerivedEvent[] {
  const events: DerivedEvent[] = [];
  {
    const first = previous === null;
    const base = {
      name: obs.name,
      observedAt: obs.fetchedAt,
      runId: obs.run,
      seq: obs.seq,
      backfill: first,
    };

    // ── gone ────────────────────────────────────────────────────────────────
    // HTTP 404. Keyed by rev so a package that keeps 404ing across many runs
    // yields one event per observed revision, not one per run.
    if (obs.outcome === 'gone') {
      events.push({
        ...base,
        id: `gone|${obs.name}|${obs.rev ?? 'norev'}`,
        kind: 'gone',
        version: null,
        at: Math.floor(Date.parse(obs.fetchedAt) / 1000),
        detail: { status: obs.status },
      });
      return events;
    }

    // ── package_unpublish ───────────────────────────────────────────────────
    // Keyed by (name, unpublishedAt), never by observation time. The feed
    // re-emits ancient deletions — nethix surfaced in 2026 having died in 2022 —
    // so without this key the graveyard would report the same death repeatedly,
    // and append-only means those rows would be permanent.
    if (obs.tombstone && obs.unpublishedAt !== null) {
      events.push({
        ...base,
        id: `punpub|${obs.name}|${obs.unpublishedAt}`,
        kind: 'package_unpublish',
        version: null,
        at: obs.unpublishedAt,
        detail: {
          by: obs.unpublishedBy,
          versions: obs.unpublishedVersions,
          createdAt: obs.created,
          ageAtDeathDays:
            obs.created !== null ? Math.round((obs.unpublishedAt - obs.created) / 86_400) : null,
          maintainers: obs.maintainers,
          // The gap between the death and our noticing it. Large values mean the
          // feed resurfaced something old, not that a package just died.
          noticedAfterDays: Math.round(
            (Date.parse(obs.fetchedAt) / 1000 - obs.unpublishedAt) / 86_400,
          ),
        },
      });
    }

    // ── version_unpublish ───────────────────────────────────────────────────
    // The malware case. Each yanked version carries its ORIGINAL publish time, so
    // the archive records both that a version vanished and when it had existed.
    // Deduped by (name, version) via the id — a yank stays visible in `missing`
    // on every subsequent observation.
    for (const [version, publishedAt] of obs.missing) {
      events.push({
        ...base,
        id: `vunpub|${obs.name}|${version}`,
        kind: 'version_unpublish',
        version,
        at: publishedAt,
        detail: { originalPublishAt: publishedAt, noticedAt: obs.fetchedAt },
      });
    }

    // ── publish ─────────────────────────────────────────────────────────────
    // Versions present now and absent from the previous observation. This is the
    // recovery of the ~46% of version events the changes feed collapses away: the
    // feed shows one row per package, the time map shows every version.
    //
    // A version dropping OUT of `times` is not an event — the row's window is a
    // fixed 7-day lookback, so old entries age out. Yanks come from `missing`.
    const previousVersions = previous === null ? new Set<string>() : versionsOf(previous);
    const detailByVersion = new Map(obs.recent.map((d) => [d.v, d]));

    for (const [version, publishedAt] of obs.times) {
      if (previousVersions.has(version)) continue;
      const d = detailByVersion.get(version);
      events.push({
        ...base,
        id: `publish|${obs.name}|${version}`,
        kind: 'publish',
        version,
        at: publishedAt,
        detail: {
          by: d?.by ?? null,
          installScripts: d?.installScripts ?? [],
          deps: d?.deps ?? null,
          integrity: d?.integrity ?? null,
          unpackedSize: d?.unpackedSize ?? null,
          fileCount: d?.fileCount ?? null,
          license: d?.license ?? null,
          repoHost: d?.repoHost ?? null,
          deprecated: d?.deprecated ?? null,
          isNewPackage: obs.isNew,
        },
      });
    }

    if (previous !== null) {
      // ── maintainer_change ─────────────────────────────────────────────────
      // Salted pseudonyms differing between observations. Sudden ownership change
      // followed by a publish with fresh install scripts is the account-takeover
      // pattern, and this is the half of it the recorder can see.
      const before = previous.maintainerHashes;
      const after = obs.maintainerHashes;
      const changed =
        before.length > 0 &&
        after.length > 0 &&
        (before.length !== after.length || before.some((h, i) => h !== after[i]));

      if (changed) {
        events.push({
          ...base,
          id: `maint|${obs.name}|${obs.rev ?? obs.fetchedAt}`,
          kind: 'maintainer_change',
          version: null,
          at: Math.floor(Date.parse(obs.fetchedAt) / 1000),
          detail: {
            fromLogins: previous.maintainers,
            toLogins: obs.maintainers,
            fromCount: before.length,
            toCount: after.length,
          },
        });
      }

      // ── rev_gap ───────────────────────────────────────────────────────────
      // npm's rev prefix is a per-document mutation counter. A jump of two or
      // more means changes we never observed — and it is the ONLY trace that
      // exists of an unpublish-then-republish inside a single interval, which
      // leaves no other evidence at any polling rate.
      const from = previous.revInt;
      const to = obs.revInt;
      if (from !== null && to !== null && to - from >= 2) {
        events.push({
          ...base,
          id: `revgap|${obs.name}|${from}-${to}`,
          kind: 'rev_gap',
          version: null,
          at: Math.floor(Date.parse(obs.fetchedAt) / 1000),
          detail: { fromRev: from, toRev: to, unexplained: to - from - 1 },
        });
      }
    }

  }

  return events;
}

/**
 * Groups mixed observations by package, orders each group, and derives.
 *
 * Sorted by `fetchedAt` then `run`, so observations written by the same run in
 * the same millisecond still order deterministically — the derivation must give
 * the same answer on every rebuild.
 */
export function deriveAll(observations: readonly Observation[]): DerivedEvent[] {
  const byName = new Map<string, Observation[]>();
  for (const obs of observations) {
    const list = byName.get(obs.name);
    if (list === undefined) byName.set(obs.name, [obs]);
    else list.push(obs);
  }

  const out: DerivedEvent[] = [];
  for (const group of byName.values()) {
    group.sort((a, b) =>
      a.fetchedAt < b.fetchedAt ? -1 : a.fetchedAt > b.fetchedAt ? 1 : a.run < b.run ? -1 : 1,
    );
    out.push(...deriveForPackage(group));
  }
  return out;
}

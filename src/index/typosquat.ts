/**
 * Typosquat scoring: how close is this brand-new name to something popular?
 *
 * This is a SIGNAL, never a verdict. Plenty of legitimate packages sit one edit
 * away from a popular one, and the output is a watchlist for a human, not an
 * accusation.
 *
 * Scored only against packages seen for the first time, and computed at index
 * time — so when the rule improves in month eight, one job re-run re-scores the
 * entire history rather than only what happens next.
 */

/**
 * Damerau-Levenshtein with a cutoff.
 *
 * The transposition case matters here specifically: `raect` for `react` is one
 * transposition but two plain Levenshtein edits, and transposition is the single
 * most common typo a human actually makes.
 *
 * Returns `cutoff + 1` as soon as the distance provably exceeds it, which is what
 * keeps ~3,000 new names a day against a 17,000-name list affordable.
 */
export function damerauLevenshtein(a: string, b: string, cutoff = 2): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > cutoff) return cutoff + 1;

  const rows: number[][] = [];
  for (let i = 0; i <= a.length; i++) rows.push(new Array<number>(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) rows[i]![0] = i;
  for (let j = 0; j <= b.length; j++) rows[0]![j] = j;

  for (let i = 1; i <= a.length; i++) {
    let best = Number.POSITIVE_INFINITY;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(
        rows[i - 1]![j]! + 1,
        rows[i]![j - 1]! + 1,
        rows[i - 1]![j - 1]! + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d = Math.min(d, rows[i - 2]![j - 2]! + 1);
      }
      rows[i]![j] = d;
      if (d < best) best = d;
    }
    // Every remaining path runs through this row, so nothing can beat its minimum.
    if (best > cutoff) return cutoff + 1;
  }
  return rows[a.length]![b.length]!;
}

/**
 * Collapses a name to the form a reader's eye sees.
 *
 * Catches the attacks edit distance misses entirely: `react-dom` vs `reactdom` is
 * one edit but visually identical in a hurried `npm install`, and homoglyph
 * substitutions (`rn`/`m`, `1`/`l`, `0`/`o`, `vv`/`w`) are zero-distance to a
 * skimming human while being several edits to a computer.
 *
 * The SCOPE IS KEPT. Stripping it made every `@anything/core` collide with
 * `@babel/core`, which on the first real run filled the watchlist with names like
 * `@testlens-reporter/core` scored 0.99. Generic last segments — core, cli, ui,
 * config — are common precisely because scopes exist to disambiguate them.
 */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[-_.]/g, '')
    .replace(/rn/g, 'm')
    .replace(/vv/g, 'w')
    .replace(/1/g, 'l')
    .replace(/0/g, 'o');
}

export type TyposquatHit = {
  readonly name: string;
  readonly target: string;
  readonly distance: number;
  readonly rank: number;
  /** Same normalised form as a popular name — visually identical, any distance. */
  readonly collision: boolean;
};

export type TyposquatScore = {
  readonly name: string;
  /** 0-1. Higher is more suspicious. A signal, not a verdict. */
  readonly score: number;
  readonly nearest: TyposquatHit[];
};

const scopeOf = (name: string): string | null => /^@([^/]+)\//.exec(name)?.[1] ?? null;
const isScoped = (name: string): boolean => name.startsWith('@');

/** Popular names indexed for cheap candidate lookup. */
export class PopularIndex {
  readonly #rankByName = new Map<string, number>();
  readonly #byNormalized = new Map<string, string[]>();
  readonly #byLength = new Map<number, string[]>();
  readonly #scopes = new Set<string>();

  constructor(ranked: readonly string[]) {
    ranked.forEach((name, i) => {
      this.#rankByName.set(name, i + 1);
      const scope = scopeOf(name);
      if (scope !== null) this.#scopes.add(scope);

      const norm = normalizeName(name);
      const byNorm = this.#byNormalized.get(norm);
      if (byNorm === undefined) this.#byNormalized.set(norm, [name]);
      else byNorm.push(name);

      const byLen = this.#byLength.get(name.length);
      if (byLen === undefined) this.#byLength.set(name.length, [name]);
      else byLen.push(name);
    });
  }

  get size(): number {
    return this.#rankByName.size;
  }

  rank(name: string): number | null {
    return this.#rankByName.get(name) ?? null;
  }

  /** True when this scope belongs to a popular package. */
  knownScope(scope: string): boolean {
    return this.#scopes.has(scope);
  }

  /**
   * Names within the edit budget by length, and of the same SHAPE.
   *
   * A scoped name is only ever compared against scoped names and an unscoped
   * against unscoped: `@foo/core` and `core` are not confusable in a package.json,
   * and mixing them was what produced the false positives.
   */
  candidates(name: string, cutoff: number): string[] {
    const scoped = isScoped(name);
    const out: string[] = [];
    for (let l = name.length - cutoff; l <= name.length + cutoff; l++) {
      for (const candidate of this.#byLength.get(l) ?? []) {
        if (isScoped(candidate) === scoped) out.push(candidate);
      }
    }
    return out;
  }

  normalizedMatchesOfSameShape(name: string): string[] {
    const scoped = isScoped(name);
    return (this.#byNormalized.get(normalizeName(name)) ?? []).filter(
      (c) => isScoped(c) === scoped,
    );
  }
}

/**
 * Shorter names get a tighter budget: at four characters almost everything is
 * within two edits of something, and the signal drowns in noise.
 */
function cutoffFor(name: string): number {
  return name.length >= 5 ? 2 : 1;
}

export function scoreName(name: string, popular: PopularIndex): TyposquatScore | null {
  // A package that IS popular is not squatting on itself.
  if (popular.rank(name) !== null) return null;

  const cutoff = cutoffFor(name);
  const hits: TyposquatHit[] = [];

  for (const target of popular.normalizedMatchesOfSameShape(name)) {
    if (target === name) continue;
    hits.push({
      name, target, collision: true,
      distance: damerauLevenshtein(name, target, cutoff),
      rank: popular.rank(target) ?? 0,
    });
  }

  const seen = new Set(hits.map((h) => h.target));
  for (const target of popular.candidates(name, cutoff)) {
    if (target === name || seen.has(target)) continue;
    const distance = damerauLevenshtein(name, target, cutoff);
    if (distance > cutoff || distance === 0) continue;
    hits.push({ name, target, distance, rank: popular.rank(target) ?? 0, collision: false });
  }

  if (hits.length === 0) return null;

  hits.sort((a, b) => a.distance - b.distance || a.rank - b.rank);
  const nearest = hits.slice(0, 3);
  const best = nearest[0]!;

  // Closeness dominates; popularity of the target breaks ties, because squatting
  // on something nobody installs is not much of an attack.
  const closeness = best.collision ? 1 : (cutoff + 1 - best.distance) / (cutoff + 1);
  const prominence = 1 - Math.min(best.rank, 5_000) / 5_000;
  let score = 0.7 * closeness + 0.3 * prominence;

  // Impersonating a popular scope is a different and nastier shape than a typo:
  // `@types/reakt` is not a slip, and edit distance against unscoped names would
  // never see it.
  const scope = scopeOf(name);
  if (scope !== null && popular.knownScope(scope)) score = Math.min(1, score + 0.15);

  return { name, score: Number(score.toFixed(3)), nearest };
}

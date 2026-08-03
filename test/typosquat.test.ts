import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  damerauLevenshtein,
  normalizeName,
  PopularIndex,
  scoreName,
} from '../src/index/typosquat.ts';

/** A small stand-in for the vendored list; rank is array order. */
const POPULAR = [
  'react', 'lodash', 'express', 'chalk', 'debug', 'cross-env', 'react-dom',
  'node-ipc', 'pusher', 'event-stream',
  '@types/react', '@types/node', '@babel/core', '@sentry/cli', '@vitest/ui',
];
const index = new PopularIndex(POPULAR);

describe('damerauLevenshtein', () => {
  it('counts a transposition as one edit, which plain Levenshtein does not', () => {
    // The most common typo a human actually makes.
    assert.equal(damerauLevenshtein('raect', 'react'), 1);
  });

  it('gives up early rather than computing a distance nobody will use', () => {
    assert.equal(damerauLevenshtein('a', 'abcdefgh', 2), 3, 'cutoff + 1');
  });

  it('handles the ordinary cases', () => {
    assert.equal(damerauLevenshtein('react', 'react'), 0);
    assert.equal(damerauLevenshtein('lodash', 'lodahs'), 1);
    assert.equal(damerauLevenshtein('express', 'expres'), 1);
  });
});

describe('normalizeName', () => {
  it('collapses what a hurried reader would not distinguish', () => {
    assert.equal(normalizeName('react-dom'), normalizeName('reactdom'));
    assert.equal(normalizeName('cross-env'), normalizeName('crossenv'));
    assert.equal(normalizeName('rnodule'), normalizeName('module'), 'rn reads as m');
    assert.equal(normalizeName('1odash'), normalizeName('lodash'), '1 reads as l');
  });

  it('KEEPS the scope', () => {
    // Stripping it made every `@anything/core` collide with `@babel/core`. On the
    // first real run that filled the watchlist with names like
    // `@testlens-reporter/core` scored 0.99, burying anything real.
    assert.notEqual(normalizeName('@babel/core'), normalizeName('@testlens/core'));
  });
});

describe('scoreName', () => {
  it('catches the real attacks', () => {
    // crossenv/cross-env is the actual 2017 npm incident.
    const crossenv = scoreName('crossenv', index);
    assert.ok(crossenv);
    assert.equal(crossenv.nearest[0]?.target, 'cross-env');
    assert.equal(crossenv.nearest[0]?.collision, true);

    assert.equal(scoreName('raect', index)?.nearest[0]?.target, 'react');
    assert.equal(scoreName('lodahs', index)?.nearest[0]?.target, 'lodash');
    assert.equal(scoreName('reactdom', index)?.nearest[0]?.target, 'react-dom');
  });

  it('catches scope impersonation, comparing scoped against scoped', () => {
    const hit = scoreName('@types/reakt', index);
    assert.ok(hit);
    assert.equal(hit.nearest[0]?.target, '@types/react');
    assert.ok(hit.score > 0.7);
  });

  it('does NOT fire on a shared generic last segment', () => {
    // The false-positive family that made the first watchlist useless. Scopes
    // exist precisely so that `core`, `cli` and `ui` can be common.
    for (const name of ['@testlens-reporter/core', '@mshkq/cli', '@laratech/ui']) {
      assert.equal(scoreName(name, index), null, name);
    }
  });

  it('does not accuse a package of squatting on itself', () => {
    assert.equal(scoreName('react', index), null);
    assert.equal(scoreName('@types/react', index), null);
  });

  it('stays quiet on names that resemble nothing popular', () => {
    assert.equal(scoreName('totally-unrelated-name-xyz', index), null);
  });

  it('never compares a scoped name against an unscoped one', () => {
    // `@foo/react` and `react` are not confusable in a package.json.
    const hit = scoreName('@somescope/react', index);
    if (hit !== null) {
      assert.ok(hit.nearest.every((h) => h.target.startsWith('@')), 'scoped targets only');
    }
  });

  it('scores a closer match higher', () => {
    const near = scoreName('lodahs', index)!;
    const far = scoreName('pushq', index)!;
    assert.ok(near.score > far.score);
  });

  it('applies a tighter budget to very short names', () => {
    // At four characters almost everything is within two edits of something.
    assert.equal(scoreName('rea', index), null);
  });
});

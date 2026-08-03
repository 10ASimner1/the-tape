import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { assertNoPII, hashEmail, PIILeakError, setSaltForTesting } from '../src/pii.ts';

setSaltForTesting('test-salt-0123456789abcdef');

const here = dirname(fileURLToPath(import.meta.url));
const raw = (n: string) =>
  readFileSync(join(here, 'fixtures', 'packuments', `${n}.json`), 'utf8');

describe('assertNoPII — the gate', () => {
  it('refuses a real packument', () => {
    // The whole point. These are verbatim registry bytes and every one of them
    // carries maintainer addresses. If this ever stops throwing, the gate is broken.
    for (const n of ['left-pad', 'lodash', 'chalk', 'event-stream']) {
      assert.throws(() => assertNoPII(raw(n), `test:${n}`), PIILeakError, n);
    }
  });

  it('refuses a TOMBSTONE — a dead package still ships maintainer emails', () => {
    // Easy to miss: the redaction path is usually written against live packuments,
    // but the graveyard is exactly what gets published.
    for (const n of ['claude-profile-switcher', 'nethix']) {
      assert.throws(() => assertNoPII(raw(n), `test:${n}`), PIILeakError, n);
    }
  });

  it('refuses the legacy 5-key unpublish block, which nests maintainers[].email', () => {
    const doc = JSON.parse(raw('tr-config')) as Record<string, unknown>;
    const unpublished = (doc['time'] as Record<string, unknown>)['unpublished'];
    assert.throws(() => assertNoPII(JSON.stringify(unpublished), 'test'), PIILeakError);
  });

  it('refuses an OSV credits[].contact address', () => {
    // Real OSV records carry a research team's address here (the amazon-inspector
    // source does). It is the field that field-by-field enumeration missed during
    // the assumptions pass, and the reason this gate is byte-level rather than a
    // field list. The address is a placeholder: this repo does not republish
    // anyone's contact details, including an organisation's.
    const osv = JSON.stringify({
      id: 'MAL-2026-10006',
      credits: [
        { name: 'Example Research', contact: ['research@example.com'], type: 'FINDER' },
        { name: 'OpenSSF', contact: ['https://github.com/ossf/package-analysis'], type: 'FINDER' },
      ],
    });
    assert.throws(() => assertNoPII(osv, 'test'), PIILeakError);
  });

  it('refuses an email key even when the value is empty or null', () => {
    assert.throws(() => assertNoPII('{"email":null}', 'test'), PIILeakError);
    assert.throws(() => assertNoPII('{"authorEmail": ""}', 'test'), PIILeakError);
    assert.throws(() => assertNoPII('{"e-mail": ""}', 'test'), PIILeakError);
  });

  it('refuses mailto:', () => {
    assert.throws(() => assertNoPII('{"url":"mailto:x"}', 'test'), PIILeakError);
  });

  it('refuses an address buried in free text, which is npm\'s own author convention', () => {
    assert.throws(
      () => assertNoPII('{"author":"Jane Doe <jane.doe@mail.example.com>"}', 'test'),
      PIILeakError,
    );
  });

  it('does not leak the address in its own error message', () => {
    try {
      assertNoPII('{"a":"someone@example.com"}', 'test');
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err instanceof PIILeakError);
      assert.ok(!err.message.includes('someone@example.com'), 'the error itself must be safe');
      assert.ok(err.message.includes('<REDACTED-ADDRESS>'));
    }
  });
});

describe('assertNoPII — does not fire on npm\'s own vocabulary', () => {
  it('passes a realistic public observation row', () => {
    const row = JSON.stringify({
      k: 'obs',
      name: '@ctrl/tinycolor',
      rev: '51-7c30d7cf',
      revInt: 51,
      distTags: { latest: '4.1.0', next: '5.0.0-beta.1' },
      maintainers: ['scttcper'],
      maintainerHashes: [hashEmail('someone@example.com')],
      times: [['4.1.0', 1785700690]],
      missing: [['4.1.1', 1780000000], ['4.1.2', 1780000100]],
      recent: [{ v: '4.1.0', integrity: 'sha512-abc+/=', repoHost: 'github.com', license: 'MIT' }],
    });
    assert.doesNotThrow(() => assertNoPII(row, 'test'));
  });

  it('passes scoped names, semver, prereleases and integrity hashes', () => {
    const safe = [
      '@babel/core', '@types/node', '@ctrl/tinycolor',
      'lodash@4.17.21', 'pkg@1.0.0-beta', 'pkg@2.0.0-rc.1', 'pkg@1.2.3-alpha.4',
      'sha512-jl3bwswu80PjjokCgh0o2w5c2U4LhQAE57gj9cz1kzA=',
      'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz',
      'publish|@ctrl/tinycolor|4.1.0', 'vunpublish|chalk|5.6.1',
    ];
    for (const s of safe) {
      assert.doesNotThrow(() => assertNoPII(JSON.stringify({ x: s }), 'test'), s);
    }
  });
});

describe('hashEmail', () => {
  it('is stable, case-insensitive and whitespace-insensitive', () => {
    const a = hashEmail('Person@Example.COM');
    assert.equal(a, hashEmail('  person@example.com  '));
    assert.match(a, /^h:[0-9a-f]{32}$/);
  });

  it('changes when the address changes — the account-takeover signal', () => {
    assert.notEqual(hashEmail('old@example.com'), hashEmail('new@example.com'));
  });

  it('produces output the gate accepts', () => {
    assert.doesNotThrow(() => assertNoPII(hashEmail('alice@example.com'), 'test'));
  });

  it('is salted, so it is not a lookup table of every npm address', () => {
    const withTestSalt = hashEmail('person@example.com');
    setSaltForTesting('a-completely-different-salt-value');
    assert.notEqual(hashEmail('person@example.com'), withTestSalt);
    setSaltForTesting('test-salt-0123456789abcdef');
  });
});

import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import {
  assertNoPersonalAddresses,
  assertNoPII,
  EMAIL_RE,
  hashEmail,
  isNonPersonalAddress,
  setSaltForTesting,
} from '../src/pii.ts';
import { redactEmailsDeep, redactPackument, REDACTION_MARKER } from '../src/redact.ts';
import { packument } from './fixtures.ts';

setSaltForTesting('test-salt-0123456789abcdef');

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, 'fixtures', 'packuments');

describe('redactEmailsDeep', () => {
  it('reaches every place npm puts an address', () => {
    // This list was written three times during development and was incomplete
    // every time. That is why the transform is byte-level over all strings
    // rather than a walk over known fields.
    const doc = {
      maintainers: [{ name: 'alice', email: 'alice@example.com' }],
      versions: { '1.0.0': { _npmUser: { name: 'bob', email: 'bob@example.com' } } },
      time: { unpublished: { maintainers: [{ name: 'carol', email: 'carol@example.com' }] } },
      bugs: { email: 'bugs@example.com' },
      author: 'Dave Smith <dave@example.com>',
      contributors: ['Eve <eve@example.com>'],
      readme: 'Contact us at readme@example.com for help.',
    };
    const out = JSON.stringify(redactEmailsDeep(doc, hashEmail));
    // The looser check: no personal address anywhere. npm's `email` KEYS survive
    // redaction by design — the archive keeps the registry's document shape and
    // the values are now salted hashes.
    assert.doesNotThrow(() => assertNoPersonalAddresses(out, 'test'));
    assert.throws(() => assertNoPII(out, 'test'), /email-key/,
      'the strict gate still refuses an email KEY, which is what the public tier uses');
    // Names survive — they are public, pseudonymous npm handles.
    for (const name of ['alice', 'bob', 'carol', 'Dave Smith', 'Eve']) {
      assert.ok(out.includes(name), `${name} should survive`);
    }
  });

  it('preserves free text around the address', () => {
    const out = redactEmailsDeep({ a: 'Dave Smith <dave@example.com> (maintainer)' }, () => 'X');
    assert.deepEqual(out, { a: 'Dave Smith <X> (maintainer)' });
  });

  it('handles two addresses run together in one field', () => {
    // Not hypothetical: ua-parser-js has a maintainer whose `email` value is two
    // addresses concatenated with no separator. Field parsing would have taken
    // that as one malformed address and passed it straight through.
    const doc = { maintainers: [{ name: 'x', email: 'alice@example.com bob@example.org' }] };
    const out = JSON.stringify(redactEmailsDeep(doc, hashEmail));
    assert.doesNotThrow(() => assertNoPersonalAddresses(out, 'test'));
    assert.equal(out.match(/h:[0-9a-f]{32}/g)?.length, 2, 'both addresses hashed, not just the first');
  });

  it('leaves git@github.com alone — it is in every SSH clone URL npm carries', () => {
    // Over-redaction destroys data just as permanently as under-redaction leaks
    // it: treating this as personal data corrupted every repository.url in the
    // fixtures the first time this ran.
    const url = 'git+ssh://git@github.com/stevemao/left-pad.git';
    const out = redactEmailsDeep({ repository: { url } }, hashEmail) as
      { repository: { url: string } };
    assert.equal(out.repository.url, url, 'the clone URL must survive intact');
    assert.doesNotThrow(() => assertNoPersonalAddresses(JSON.stringify(out), 'test'));
  });

  it('keeps npm@npmjs.com, which the security-holder rule depends on', () => {
    // An organisational role address, not personal data. Redacting it would break
    // a detector to protect nobody.
    const out = redactEmailsDeep({ maintainers: [{ name: 'npm', email: 'npm@npmjs.com' }] },
      hashEmail) as { maintainers: Array<{ email: string }> };
    assert.equal(out.maintainers[0]!.email, 'npm@npmjs.com');
  });

  it('leaves non-string values alone', () => {
    const doc = { n: 42, b: true, nul: null, arr: [1, 'a@b.com', { deep: 'c@d.com' }] };
    const out = redactEmailsDeep(doc, () => 'X') as typeof doc;
    assert.equal(out.n, 42);
    assert.equal(out.b, true);
    assert.equal(out.nul, null);
    assert.deepEqual(out.arr, [1, 'X', { deep: 'X' }]);
  });
});

describe('redactPackument', () => {
  it('marks the document as altered', () => {
    // A retained packument is no longer byte-identical to what npm served. An
    // archive that quietly reshapes its own evidence is worth less than one that
    // says so.
    const out = redactPackument(packument('left-pad'), hashEmail);
    assert.equal(out[REDACTION_MARKER], true);
  });

  it('produces a document the gate accepts', () => {
    // Including a modern tombstone (nethix) and a legacy 5-key one (tr-config),
    // whose nested unpublished.maintainers[].email is the source most likely to
    // be missed by anything that walks known fields.
    for (const name of ['left-pad', 'lodash', 'nethix', 'tr-config', 'flatmap-stream',
                        'crossenv', 'ua-parser-js']) {
      const text = JSON.stringify(redactPackument(packument(name), hashEmail));
      assert.doesNotThrow(() => assertNoPersonalAddresses(text, name), name);
    }
  });

  it('keeps everything the rules need', () => {
    const original = packument('chalk') as Record<string, unknown>;
    const redacted = redactPackument(original, hashEmail);
    assert.deepEqual(Object.keys(redacted['time'] as object).sort(),
                     Object.keys(original['time'] as object).sort());
    assert.deepEqual(redacted['dist-tags'], original['dist-tags']);
  });
});

describe('the committed fixtures carry no real addresses', () => {
  it('holds for every fixture file', () => {
    // These are captures of live registry data, which means real people's contact
    // details. They are pseudonymised before being committed — this repo is public,
    // and a bulk maintainer contact corpus is exactly what this project's policy
    // exists to prevent.
    const offenders: string[] = [];
    for (const file of readdirSync(fixtureDir).filter((f) => f.endsWith('.json'))) {
      // Remove each pseudonym individually before scanning. ua-parser-js has a
      // maintainer whose address field held two addresses with no separator, so
      // the two pseudonyms sit flush against each other and a naive scan reads
      // them as one malformed token.
      const text = readFileSync(join(fixtureDir, file), 'utf8')
        .replace(/maintainer\d+@redacted\.invalid/g, ' ');
      for (const match of text.match(new RegExp(EMAIL_RE.source, 'g')) ?? []) {
        if (isNonPersonalAddress(match)) continue;
        offenders.push(`${file}: ${match}`);
      }
    }
    assert.deepEqual(offenders, [], 'a public repo must not carry maintainer contact details');
  });
});

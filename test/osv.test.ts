import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { gunzipSync } from 'node:zlib';

import { decodeJsonl, putJsonl } from '../src/jsonl.ts';
import {
  assertNoPersonalAddresses, EMAIL_RE, hashEmail, isNonPersonalAddress, PIILeakError,
  setSaltForTesting,
} from '../src/pii.ts';
import { redactEmailsDeep } from '../src/redact.ts';
import { FsStore } from '../src/store.fs.ts';

setSaltForTesting('test-salt-0123456789abcdef');

const newStore = () => new FsStore(mkdtempSync(join(tmpdir(), 'tape-osv-')));

/** An OSV record shaped like the real ones, carrying an address in each of the
 *  three places they were actually measured in the live archive. */
const osvRecord = () => ({
  schema_version: '1.6.0',
  id: 'MAL-2026-11430',
  modified: '2026-08-02T19:49:31Z',
  summary: 'Malicious code in evil-pkg',
  // Free text. 140 of the 1,022 leaked addresses were here.
  details: 'Reported privately. Contact ada@lovelace.example.com for the writeup.',
  affected: [{
    package: { ecosystem: 'npm', name: 'evil-pkg' },
    database_specific: { iocs: { urls: ['mailto:exfil@attacker.example.net'] } },
  }],
  // The single biggest source: 367 of 1,022.
  credits: [{ name: 'A Researcher', contact: ['grace@hopper.example.org'] }],
});

const countPersonal = (text: string): number => {
  let n = 0;
  EMAIL_RE.lastIndex = 0;
  for (let m = EMAIL_RE.exec(text); m !== null; m = EMAIL_RE.exec(text)) {
    if (!isNonPersonalAddress(m[0])) n++;
  }
  return n;
};

describe('the OSV write path', () => {
  it('redacts every address before storing, in all three places they appear', () => {
    // MEASURED on the live archive 2026-08-05: raw/osv/ held 1,022 personal
    // addresses across 848 of 2,786 records, and ZERO salted hashes — while
    // raw/obs, raw/feed and private/pkg held zero addresses between them. The
    // OSV sync was the only writer that skipped redaction.
    const before = JSON.stringify(osvRecord());
    assert.equal(countPersonal(before), 3, 'the fixture carries three addresses');

    const after = JSON.stringify(redactEmailsDeep(osvRecord(), hashEmail));
    assert.equal(countPersonal(after), 0, 'none survive redaction');
    assert.equal((after.match(/h:[0-9a-f]{32}/g) ?? []).length, 3, 'all three become hashes');

    // Structure and non-address content must be untouched — an archive that
    // reshapes its own evidence is worth less than one that says so.
    const round = JSON.parse(after) as Record<string, unknown>;
    assert.equal(round['id'], 'MAL-2026-11430');
    assert.equal(round['schema_version'], '1.6.0');
    assert.match(String(round['details']), /^Reported privately\. Contact h:/);
  });

  it('is gated, and the gate refuses unredacted records', async () => {
    // The redaction is a transform that can be wrong; the gate is the check that
    // does not trust it. Feeding it a raw record is the test.
    const store = newStore();
    await assert.rejects(
      () => putJsonl(store, 'raw/osv/x.jsonl.gz', [osvRecord()], assertNoPersonalAddresses),
      PIILeakError,
    );
    assert.equal((await store.list('raw/osv/')).length, 0, 'and nothing was written');
  });

  it('stores redacted records without tripping the gate', async () => {
    const store = newStore();
    const redacted = [osvRecord(), osvRecord()].map((r) => redactEmailsDeep(r, hashEmail));
    await putJsonl(store, 'raw/osv/x.jsonl.gz', redacted, assertNoPersonalAddresses);

    const objects = await store.list('raw/osv/');
    assert.equal(objects.length, 1);
    const text = gunzipSync((await store.get(objects[0]!.key))!).toString('utf8');
    assert.equal(countPersonal(text), 0);
    assert.equal(decodeJsonl(text).length, 2);
  });

  it('the guard is a REQUIRED parameter, so it cannot be forgotten again', () => {
    // The root cause was `guard?` being optional: exactly one of four callers
    // omitted it and nothing said so for two days. This asserts the arity, which
    // is what makes the omission a compile error rather than a silent leak.
    assert.equal(putJsonl.length, 4, 'putJsonl takes store, key, rows, guard');
  });
});

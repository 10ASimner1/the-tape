/**
 * The email rule, and the mechanism that enforces it.
 *
 * Policy: a raw email address is never written anywhere — not to the public tier,
 * not to the archive, not to a log. Addresses are replaced at parse time with a
 * salted hash, which preserves the one thing they are actually useful for
 * (detecting a maintainer email change, the account-takeover signal) without
 * creating a bulk contact corpus.
 *
 * Enforcement is NOT field enumeration. Enumeration has already been shown to
 * miss sources: the assumptions pass carefully enumerated npm's email fields
 * (maintainers[].email, versions[x]._npmUser.email, time.unpublished.maintainers[].email,
 * author/contributors free text, bugs.email) and still missed OSV credits[].contact.
 * Any list written today is wrong the first time an upstream adds a field.
 *
 * Instead: one byte-level assertion over the FINAL SERIALIZED BYTES at a single
 * egress chokepoint. It is immune to schema drift, to nested objects someone
 * forgot, and to a future refactor that reintroduces a spread. It throws rather
 * than redacts, because silent redaction would let the drift go undetected.
 */

import { createHash } from 'node:crypto';

/** Domain separator between salt and address, so salt+value can never be
 *  ambiguous with a different salt+value pair. Written as an escape rather than a
 *  literal control character: a raw NUL makes git treat the file as binary, which
 *  silently excluded this very file from the PII audit. */
const SALT_SEPARATOR = '\u0000';

let cachedSalt: string | null = null;

function salt(): string {
  if (cachedSalt !== null) return cachedSalt;
  const s = process.env['TAPE_PII_SALT'];
  if (s === undefined || s.length < 16) {
    throw new Error(
      'TAPE_PII_SALT must be set to at least 16 characters. It is what makes maintainer ' +
        'hashes non-reversible; an unsalted hash of an email is a reversible email. ' +
        'Generate one with: node -e "console.log(require(\'node:crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }
  cachedSalt = s;
  return s;
}

/** For tests only — lets a fixture pin a known salt without touching process.env ordering. */
export function setSaltForTesting(s: string): void {
  cachedSalt = s;
}

/**
 * Stable pseudonym for an email address. Constant per archive, so it joins across
 * packages and across time; not reversible without the salt, which lives only in
 * an Actions secret and never in the archive.
 */
export function hashEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  const digest = createHash('sha256')
    .update(salt(), 'utf8')
    .update(SALT_SEPARATOR, 'utf8')
    .update(normalized, 'utf8')
    .digest('hex');
  return `h:${digest.slice(0, 32)}`;
}

/**
 * Matches an address anywhere in a blob of text.
 *
 * Safe against npm's own vocabulary: a scoped name has no dot between `@` and `/`
 * and nothing matchable before the `@`; `name@1.2.3` fails because the tail after
 * the last dot is digits, not two-plus letters. The realistic false positive is a
 * package reference whose prerelease tag ends in letters, written inline in prose —
 * and prose never reaches a public row, so a hit means something is genuinely wrong.
 *
 * One false positive costs one run out of ~17,500 a year. One false negative costs
 * the project. That trade is the design.
 *
 * The quantifiers are BOUNDED, and that is not cosmetic.
 *
 * Unbounded (`+`), this backtracks quadratically on a long run of local-part
 * characters with no `@` after it: the run matches whole, fails, gives back one
 * character, fails, and so on. MEASURED on a run of a single repeated letter:
 * 10 KB took 44 ms, 100 KB took 4.3 s, and 400 KB did not finish in a minute.
 *
 * The gate runs over whole packuments — the largest real one seen is 12 MB — so
 * one package carrying a long unbroken base64 or hex blob could stall a run past
 * its own deadline and into the workflow's SIGKILL, which abandons the deferred
 * queue and the manifest. That is precisely the "a single bad package must never
 * stop a run" rule, defeated by a regex.
 *
 * The bounds come from RFC 5321 — local part at most 64 octets, domain at most
 * 255 — so they make the pattern MORE correct, not less, and they were verified
 * to match identically on every address form in the tests. With them the same
 * 8 MB input scans in about a second, linearly.
 */
export const EMAIL_RE = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}/g;

/**
 * Addresses that identify a service, not a person.
 *
 * `git@github.com` is the local part of every SSH clone URL npm carries in
 * `repository.url`, and treating it as personal data both corrupted the repo URLs
 * during redaction and made the gate reject documents that contained one. The
 * local part is restricted to VCS conventions so this stays narrow: a real person
 * whose address begins `git@` is unidentifiable by it anyway.
 *
 * `npm@npmjs.com` is an organisational role address and the security-holder rule
 * is a conjunction that matches it exactly.
 */
const VCS_LOCAL_PART = /^(?:git|hg|svn)@/i;
const ROLE_ADDRESSES = new Set([
  'npm@npmjs.com',
  // GitHub's own Actions bot, needed as a git commit identity in the publish
  // workflow. Deliberately this exact address rather than the whole noreply
  // domain: a per-user noreply address embeds the username and so does identify
  // a person.
  '41898282+github-actions[bot]@users.noreply.github.com',
]);

export function isNonPersonalAddress(address: string): boolean {
  return VCS_LOCAL_PART.test(address) || ROLE_ADDRESSES.has(address.toLowerCase());
}

/** First personal address in the text, or null. */
function findPersonalAddress(text: string): RegExpExecArray | null {
  EMAIL_RE.lastIndex = 0;
  for (let m = EMAIL_RE.exec(text); m !== null; m = EMAIL_RE.exec(text)) {
    if (!isNonPersonalAddress(m[0])) return m;
  }
  return null;
}

/** Any JSON key whose name suggests it carries contact data. Catches a field we
 *  forgot to project away even when its value happens to be empty or null. */
const EMAIL_KEY_RE = /"[A-Za-z_]*e-?mail[A-Za-z_]*"\s*:/i;

/**
 * A `mailto:` pointing at anything that is not an already-redacted hash.
 *
 * This was a bare /mailto:/i and it stopped the recorder in production. npm
 * READMEs routinely contain markdown links like `[Email](mailto:someone@example.com)`;
 * redaction correctly rewrote the address to a hash, and then the gate refused
 * the write anyway because the literal word "mailto:" was still there. A rule
 * that fires on already-safe content is not caution, it is an outage.
 *
 * The address rule above is what actually protects people. This one only adds
 * value for a malformed target that EMAIL_RE would miss, so it now looks at the
 * target rather than the scheme.
 */
const MAILTO_RE = /mailto:(?!h:[0-9a-f]{32}\b)[^\s"'<>)\]]+/i;

export class PIILeakError extends Error {
  readonly rule: string;
  readonly sample: string;
  constructor(rule: string, sample: string, where: string) {
    super(
      `PII gate refused a write to ${where}: matched rule "${rule}". ` +
        `This is not a false alarm to route around — find the field and project it away. ` +
        `Context (redacted): ${sample}`,
    );
    this.name = 'PIILeakError';
    this.rule = rule;
    this.sample = sample;
  }
}

/** Show enough context to find the field, without reprinting the address itself. */
function redactedContext(text: string, index: number): string {
  const start = Math.max(0, index - 60);
  const slice = text.slice(start, Math.min(text.length, index + 60));
  return slice.replace(new RegExp(EMAIL_RE.source, 'g'), '<REDACTED-ADDRESS>');
}

const asText = (bytes: string | Uint8Array): string =>
  typeof bytes === 'string' ? bytes : Buffer.from(bytes).toString('utf8');

/**
 * The rule that actually protects people: no personal address, in any form,
 * anywhere in these bytes. Applied to EVERYTHING the recorder writes.
 */
export function assertNoPersonalAddresses(bytes: string | Uint8Array, where: string): void {
  const text = asText(bytes);

  const email = findPersonalAddress(text);
  if (email) throw new PIILeakError('email-address', redactedContext(text, email.index), where);

  const mailto = MAILTO_RE.exec(text);
  if (mailto) throw new PIILeakError('mailto', redactedContext(text, mailto.index), where);
}

/**
 * The strict gate, for the public tier and for the observation rows the index and
 * every downstream artifact are built from. Adds the structural rule: no field
 * that even claims to hold contact data.
 *
 * Retained packuments deliberately use the looser check above instead. They keep
 * npm's own document shape — including a `maintainers[].email` key whose value is
 * now a salted hash — because reshaping archived evidence to satisfy a naming rule
 * costs fidelity and protects nobody. The address rule still applies to them in full.
 *
 * That extends to the SHARDS they are written into, and there it is not a matter
 * of taste. A ShardWriter guard throw is caught nowhere, so using this strict gate
 * on a packument shard would not skip a package — EMAIL_KEY_RE would fire on
 * essentially every shard and stop the tape outright. private/packuments/ is
 * guarded with `assertNoPersonalAddresses`, and there is a test that fails the day
 * someone changes it.
 */
export function assertNoPII(bytes: string | Uint8Array, where: string): void {
  const text = asText(bytes);
  assertNoPersonalAddresses(text, where);

  const key = EMAIL_KEY_RE.exec(text);
  if (key) throw new PIILeakError('email-key', redactedContext(text, key.index), where);
}

/**
 * Note for anyone adding public output: prefer arrays of records over objects
 * keyed by package name. A package is allowed to be called `email`, and as an
 * object key it would trip EMAIL_KEY_RE. As a value it is harmless.
 */

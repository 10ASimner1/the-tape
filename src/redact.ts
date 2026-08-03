/**
 * Email redaction, applied to anything that gets written down.
 *
 * `assertNoPII` is the gate that catches mistakes; this is the thing that means
 * there are none to catch. The two are deliberately separate: redaction is a
 * transform that can be wrong, and the gate is an independent check that does not
 * trust it.
 *
 * This is byte-level over every string in the document rather than a list of known
 * fields, because npm puts addresses in at least seven places — `maintainers[].email`,
 * `versions[x]._npmUser.email`, `time.unpublished.maintainers[].email`, `bugs.email`,
 * `author` and `contributors[]` as free text ("Name <alice@example.com>"), and README bodies —
 * and that list was still incomplete the last three times it was written.
 */

import { EMAIL_RE, isNonPersonalAddress } from './pii.ts';

export type Replacer = (email: string) => string;

/**
 * Non-personal addresses are left alone — see `isNonPersonalAddress`. Redacting
 * `git@github.com` out of a `repository.url` corrupted every SSH clone URL in the
 * fixtures the first time this ran, which is a good reminder that over-redaction
 * destroys data just as permanently as under-redaction leaks it.
 */
export function redactEmailsInString(text: string, replace: Replacer): string {
  return text.replace(new RegExp(EMAIL_RE.source, 'g'), (match) =>
    isNonPersonalAddress(match) ? match : replace(match),
  );
}

/**
 * Recursively rewrites every string in a JSON value. Object KEYS are rewritten
 * too: npm does not currently key anything by address, but `versions` is keyed by
 * attacker-chosen strings and this costs nothing.
 */
export function redactEmailsDeep(value: unknown, replace: Replacer): unknown {
  if (typeof value === 'string') return redactEmailsInString(value, replace);
  if (Array.isArray(value)) return value.map((v) => redactEmailsDeep(v, replace));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[redactEmailsInString(k, replace)] = redactEmailsDeep(v, replace);
    }
    return out;
  }
  return value;
}

/**
 * Marks a stored document as altered.
 *
 * A retained packument is no longer byte-identical to what npm served, and an
 * archive that quietly reshapes its own evidence is worth less than one that says
 * so. The key is namespaced so it cannot collide with registry fields.
 */
export const REDACTION_MARKER = '_tape_email_redacted';

export function redactPackument(doc: unknown, replace: Replacer): Record<string, unknown> {
  const redacted = redactEmailsDeep(doc, replace) as Record<string, unknown>;
  return { ...redacted, [REDACTION_MARKER]: true };
}

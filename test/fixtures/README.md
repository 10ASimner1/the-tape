# Fixtures

Captures of real npm registry responses, taken 2026-08-02. They are the evidence
behind every rule in `src/packument.ts`, so any claim in the tests can be checked
against them directly.

## They are pseudonymised, and this is the one way they differ from what npm served

Every email address has been replaced with a stable `maintainerN@redacted.invalid`
pseudonym. Nothing else is altered — structure, version maps, timestamps, `_rev`
values, dist-tags, integrity hashes and READMEs are exactly as returned.

This repo is public. The captures originally carried **229 distinct real maintainer
addresses across 10,225 occurrences**, which is precisely the bulk contact corpus
this project's own PII policy exists to prevent. Keeping them would have made the
repo an instance of the problem it studies.

`npm@npmjs.com` is deliberately preserved: it is an organisational role address, not
personal data, and the security-holder detector is a conjunction that matches it
exactly.

`.invalid` is reserved by RFC 2606 and can never be a real domain, so the pseudonyms
are inert while still being shaped like addresses — which matters, because several
tests assert that the PII gate *refuses* a packument-shaped document.

## What each one is here to prove

| fixture | why it is here |
|---|---|
| `chalk`, `debug`, `event-stream`, `ua-parser-js`, `coa`, `rc`, `_ctrl_tinycolor` | Real supply-chain incidents. Per-version unpublish sets **no** `time.unpublished`; these are only detectable as a set difference. |
| `left-pad`, `lodash`, `compresion` | Clean controls. The detector must stay silent on these. |
| `nethix` | `time.modified` (2026-08-01) is four years after `time.unpublished.time` (2022-03-11). Stamping events with `modified` would report ancient deaths as today's news. |
| `glace-tpl`, `claude-profile-switcher`, `_openpond_sdk` | Modern 2-key tombstones. |
| `tr-config`, `cjhooker-test` | Legacy 5-key tombstones, which carry the unpublishing **username**. ~28% of historical tombstones look like this. |
| `flatmap-stream` | A genuine npm security-holding package — and it also has a yanked version. |
| `crossenv` | The adversarial case: `0.0.1-security` was published by the **attacker** from npm's own holder template, so the version name alone proves nothing. |
| `compresion` | Maintained by `npm` but with entirely normal content — a `maintainers == npm` rule would produce 1,624 false positives like this. |
| `_ctrl_tinycolor`, `_openpond_sdk` | Scoped names, which are 77.5% of live npm activity. |

## Re-capturing

```bash
curl -H "User-Agent: the-tape/0.1 (fixture capture)" \
  "https://registry.npmjs.org/$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' chalk)"
```

Redact before committing — `redactEmailsDeep` in `src/redact.ts` is the same
function the recorder uses on the archive path.

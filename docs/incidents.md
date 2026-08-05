# Incidents

Part III §8 and §5 require that credential exposure, archive damage, and any
alteration of the private raw tape are written down. This is that log.

Newest first. Each entry: what happened, how it was found, what was done, and what
changed so it cannot happen the same way twice.

---

## 2026-08-05 — raw personal addresses written to `raw/osv/`

**Severity: high.** Rule 2 — *"No personal email address is written anywhere"* —
was broken in production for the lifetime of the OSV sync.

### What happened

`syncOsv` stored OSV records **unredacted and ungated**. Measured across the
archive with the project's own `EMAIL_RE`, counting only:

| prefix | records | records with an address | addresses | salted hashes |
|---|---|---|---|---|
| **`raw/osv/`** | 2,786 | **848** | **1,022** | **0** |
| `raw/obs/` | 11,809 | 0 | 0 | 51,457 |
| `raw/feed/` | 28,255 | 0 | 0 | 0 |
| `private/pkg/` | 1,652 | 0 | 0 | 215,189 |

The addresses are in `credits[].contact[]`, in `details` free text, and in
`affected[].database_specific` IOC urls.

**Tier:** the data is in the private archive (Tier 1), never in the public tier.
The published digest was checked and is clean — `digest.ts` gates its own output.
No address reached git, the digests, or the index's public artifacts.

### Cause

One character. `putJsonl`'s `guard` parameter was optional, and exactly one of its
four callers omitted it — `src/osv.ts:141`. Every other writer passed
`assertNoPII`.

`src/pii.ts`'s header names OSV `credits[].contact` as the field a careful field
enumeration missed, and argues that a byte-level gate at a single egress
chokepoint makes enumeration unnecessary. That argument is correct. It is simply
not true of a code path that never calls the chokepoint.

### Found by

A health audit on 2026-08-05, two days after the Class B outage. Not by any alarm
— nothing in the system was watching for this, because the design assumed the
chokepoint was unavoidable.

### Fixed

- `src/osv.ts` — records are redacted byte-level over every string via
  `redactEmailsDeep(r, hashEmail)` and gated with `assertNoPersonalAddresses`,
  the same treatment retained packuments get.
- `src/jsonl.ts` — the guard is now a **required** parameter on both `putJsonl`
  and `ShardWriter`. Forgetting it is a compile error. `noGuard` exists as a
  visible opt-out and has no callers, which is the intended number.
- `test/osv.test.ts` — pins the redaction of all three field shapes, that the
  gate refuses an unredacted record, and the arity of `putJsonl`.

### Outstanding

**4 objects under `raw/osv/` in the live bucket still carry the addresses**, as do
2 copies on the local disk mirror and the local `.tape-index.sqlite`.

Listed 2026-08-05: 4 keys, 4 versions, 0 delete markers, all current. The bucket
lifecycle is *keep all versions*, so an ordinary delete writes a delete marker and
leaves the bytes retrievable by version id — removal requires **version-scoped**
deletes.

Part III §5 states the private raw tape is altered only under legal compulsion.
This is not that case: it is the correction of data written in violation of the
project's own policy. The decision, and the removal itself, are the operator's.
**Record the outcome here when done.**

---

## 2026-08-05 — a maintainer address printed into a public workflow log

**Severity: moderate.** GitHub retains workflow logs for 90 days.

`PIILeakError`'s message quotes surrounding bytes so the offending field can be
found. `redactedContext` masked only what `EMAIL_RE` matches — so a
**percent-encoded** address (`%40` where the `@` should be) was not masked, and
was printed verbatim into the log for run `30786278011` on 2026-08-03.

The gate refused the write and leaked the address in the act of refusing. The
error message is the one place where a *near miss* of the address rule is still a
leak, because the function exists to quote bytes that just failed the check.

**Fixed:** `redactedContext` now masks the escaped spellings — `%40`, `&#64;`,
`&commat;`, `[at]`, `(at)` — before applying the literal rule. A false positive
there costs nothing; the output is a debugging hint, not evidence.

**Outstanding:** the existing log cannot be altered from the recorder. Deleting
run `30786278011`'s logs is a GitHub action.

---

## 2026-08-03 — the tape stopped at 0.4% of its storage tier

**Severity: high, no data lost.**

Backblaze's free **Class B** allowance (2,500/day, and a `HEAD` counts) was
exhausted while the bucket held 44 MB of a 10 GB tier. A $0-capped account
hard-stops rather than billing: `GET` returned 403 while `PUT` kept working, so
the recorder could not read its own cursor and every run failed for ~7 hours
until the daily reset.

**Cause.** `docs/assumptions.md` §5 claimed B2 gives *"10 GB free with free Class
A/B/C transactions"*. Only Class A is free and unlimited. That claim was taken at
face value when designing the mirror, and 96% of objects were retained packuments
costing two Class B each — a `HEAD` to write, a `GET` to mirror.

**No loss.** The read fails before `COMMIT A`, so the cursor never advanced and
the backlog drained cleanly afterwards: 17,360 deferred rows down to 52 over the
following day.

**Fixed.** Retained packuments batched into shards (1,704 objects → 18 measured);
shard caps raised after measuring that observations bound on rows at 227/250 while
using a third of their byte budget; `S3Store` now counts transactions by class and
logs them every run. Steady state measured afterwards: **3 Class B per recorder
run**, invariant with work.

**Also found while fixing it.** `EMAIL_RE` backtracked quadratically on a long run
of local-part characters — 44 ms at 10 KB, 4.3 s at 100 KB, no completion at
400 KB. The gate runs over whole packuments and the largest real one is 12 MB, so
one package carrying a long base64 blob could have stalled a run into the
workflow's `SIGKILL`, abandoning the deferred queue and the manifest. Quantifiers
bounded to RFC 5321's limits.

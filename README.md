# The Tape

An always-on recorder of npm publish, update and — critically — **unpublish** events,
into an append-only archive.

Unpublished packages vanish from every public record. Every day not recorded is lost
forever. This keeps the tape rolling.

**Status: M3.** The recorder runs on GitHub Actions every 15 minutes, writing to an
S3-compatible bucket. A nightly job rebuilds a SQLite index from the raw archive,
joins OSV advisories, scores typosquats and publishes a
[daily digest](digests/) — the graveyard is the headline.

npm explicitly permits this. Its [crawler policy](https://docs.npmjs.com/policies/crawlers/)
states that a full metadata copy via CouchDB replication *"is acceptable within our
terms of use"*.

---

## What it records, and what it honestly cannot

**Records:** every change to a package's `_rev`, and every version present in the
packument's `time` map at the moment of observation — with gaps written as
first-class rows rather than left as silence.

That phrasing is deliberate. "Every publish event" is not deliverable, because:

- The changes feed **coalesces** to one row per package per query window. A package publishing five versions between two runs appears once, and ~46% of version-level events never appear as feed rows at all.
- **Unpublish-then-republish inside one interval leaves zero trace anywhere**, at any polling rate. `left-pad` — the most famous unpublish in npm history — has no `time.unpublished` today.

Both are recovered or documented rather than papered over. See
[docs/assumptions.md](docs/assumptions.md) §7.

## How it works

**The packument is the state.** npm's `time` map is its own server-side log of every
version that ever existed, with a timestamp the publisher cannot forge. So the
recorder keeps **no durable per-package state** — one fetch recovers everything,
including the complete unpublish history of a package it is seeing for the first time.

Two rules do the heavy lifting, both verified against every real supply-chain
incident we could find, with zero false positives on clean controls:

```js
// Every version publish, including the ~46% the feed hides
Object.keys(time) − {created, modified, unpublished}

// Every per-version unpublish — the malware case, which sets no time.unpublished
Object.keys(time) − {created, modified, unpublished} − Object.keys(versions)
```

The second one finds `chalk@5.6.1`, `debug@4.4.2`, `event-stream@3.3.6`,
`ua-parser-js@0.7.29`, `@ctrl/tinycolor@4.1.1` and the rest — none of which are
detectable any other way.

### The ordering that matters

```
drain the feed → COMMIT A (feed bytes durable) → COMMIT B (cursor advances)
               → fetch packuments → COMMIT C (deferred queue + manifest)
```

The cursor guards the **feed**, not the fetch queue. The feed is queryable forward
only and has no substitute anywhere on the internet; packuments are re-fetchable
forever from rows already stored. So the irreplaceable thing is made durable first
and the replaceable thing gets a retry queue.

**Every failure window in that ordering produces duplicates. None produces loss.**
This is enforced by the type system, not by a comment: `cursor.advance()` requires a
`FeedReceipt`, and only `writeFeedBlob()` can mint one.

### No emails, anywhere

Addresses are replaced at parse time with a salted hash. That keeps the one thing
they are useful for — detecting a maintainer email **change**, the account-takeover
signal — without creating a bulk contact corpus.

Enforcement is not a field list. Field-by-field enumeration was tried during the
assumptions pass and still missed a source (OSV `credits[].contact`). Instead
redaction is byte-level over every string in the document, and a separate
byte-level gate runs over the **final serialized bytes** before a write and
**throws** rather than redacts. Feeding that gate a real packument is a test: it
must refuse.

The two are deliberately independent — redaction is a transform that can be wrong,
and the gate is a check that does not trust it. That separation earned its keep
during M1: retained packuments were being stored verbatim, and a sweep of the
archive found real addresses that the row-level gate never saw.

Scope, precisely: the gate runs on the feed blob, the observation shards, the
deferred queue and every retained packument. The run manifest and the cursor are
not gated — they contain only counts, keys and hashes. A scheduled sweep of the
whole archive is Phase 2 work and does not exist yet.

Retained packuments are therefore stored redacted and carry a
`_tape_email_redacted` marker. They are no longer byte-identical to what npm
served, and an archive that quietly reshapes its own evidence is worth less than
one that says so.

## Running it

Requires **Node 24**. There are **zero runtime dependencies** — this is a
supply-chain-security project, so the recorder runs on Node built-ins alone and has
no lockfile attack surface to become the story about.

```bash
npm install                    # devDependencies only: typescript, @types/node
npm test                       # against real captured packuments
npm run typecheck
node scripts/pii-audit.ts      # refuses any personal address in the tree
```

```bash
export TAPE_PII_SALT=$(node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")
node src/main.ts bootstrap --hours 1
node src/main.ts record
```

The salt must never change once the archive has data — the hashes would stop joining
across time. In CI it is an Actions secret.

| variable | purpose |
|---|---|
| `TAPE_PII_SALT` | **Required.** Salt for maintainer hashes. Never change it once the archive has data. |
| `TAPE_S3_ENDPOINT` `TAPE_S3_REGION` `TAPE_S3_BUCKET` `TAPE_S3_KEY_ID` `TAPE_S3_SECRET` | The object store. **All five or none** — a partial config is a startup error, never a silent fallback to local disk. |
| `TAPE_STORE_DIR` / `--local` | Opt in to the filesystem store for development. |
| `TAPE_HEALTHCHECK_URL` | Dead-man's switch. Without it a silent stop goes unnoticed. |
| `TAPE_REPO_URL` / `TAPE_CONTACT` | Go in the User-Agent. npm reserves the right to ban by user-agent, so being contactable is the difference between an email and a ban. |

Modes: `bootstrap` · `record` · `store-check` (round-trips one object to verify
credentials) · `recover-cursor` (re-derives the position from the archive).

## The archive

```
raw/feed/YYYY/MM/DD/<since>-<last>.jsonl.gz   verbatim feed rows — THE irreplaceable file
raw/obs/YYYY/MM/DD/<runId>/part-NNN.jsonl.gz  observation rows — what the index is built from
raw/runs/YYYY/MM/DD/<runId>.json              manifest: sha256 of everything written
private/pkg/<name>/<rev>.json.gz              full packuments, retained for ~11% of changes
work/deferred/current.jsonl.gz                retry queue — overwritten each run, so no
                                              credential needs delete permission
state/cursor.json                             ~300 bytes; the whole mutable state
```

Nothing is named by wall-clock hour: GitHub drops scheduled runs under load, so an
hour-keyed object would silently gain holes. Keys are named by run id and seq range.

### Rebuilding from raw

The observation row is **absolute, not relative** — it records what the packument
said, not a diff against something remembered. That is what makes backlogs and
retries harmless (a packument fetched seven hours late still carries its complete
`time` map) and it is what makes the index genuinely disposable:

1. Read `raw/obs/**` in `runId` order.
2. Group by `name`, ordered by `fetchedAt`.
3. **Publishes:** versions in `times` absent from that package's previous observation.
4. **Version unpublishes:** the `missing` array — each entry carries the version's *original* publish time.
5. **Package unpublishes:** `tombstone: true`; the timestamp is `unpublishedAt`, never `modified`.
6. **Unexplained mutations:** a `revInt` jump of ≥2 with no explained change — the only trace of an unpublish/republish cycle.

`versionCount` and `versionsDigest` are on every row, so truncation (`truncated: true`)
is always detectable rather than silent.

## Cost

Measured, not estimated: **1,711 bytes gzipped per changed package** → ~**36 MB/day**,
~**13 GB/year** at npm's current rate of ~20,900 changed packages/day.

The first live run came in at 469 MB/day. Two constants fixed it, and the story is in
[docs/assumptions.md](docs/assumptions.md) §6 — worth reading before changing any
retention rule.

| | |
|---|---|
| GitHub Actions | £0 — unlimited on public repos with standard runners |
| Object storage | £0 for roughly the first 9 months (10 GB free tier), then pennies per month |
| Domain | **~$12.87/year** |

So the honest claim is **$0/month infrastructure, plus a domain** — not "$0/month".
The domain is the project's only committed recurring cost, and it exists because
Part III requires a contact address in the User-Agent that isn't a personal one.

A self-imposed spend cap is **not implemented yet** — object stores bill overage
rather than stopping, so the recorder should stop itself, and currently it cannot.
Measured growth crosses the free tier around day 400, so this is scheduled work
rather than an emergency. Until then, watch the bucket.

## Layout

| file | what it is |
|---|---|
| `src/packument.ts` | **Every measured rule, as pure functions.** The most important file here; every test points at it. |
| `src/run.ts` | The run loop and the commit ordering. The file to open first at 2am. |
| `src/pii.ts` | The email rule and the gate that enforces it. |
| `src/feed.ts` | The changes feed, and `FeedReceipt`. |
| `src/cursor.ts` | The entire durable mutable state. |
| `src/observation.ts` | The archive's unit of record. |
| `src/index/derive.ts` | Observations → events. Every rule the recorder deliberately does *not* apply at write time. |
| `src/index/digest.ts` | The daily digest, including the graveyard. Gated on every write. |
| `src/config.ts` | Every tunable, with the measurement behind it. |
| `docs/HANDOFF.md` | **Start here to operate it.** State, runbook, known holes, what's outstanding. |
| `docs/assumptions.md` | What was verified against the live APIs, and when. |

Test fixtures are real registry captures, stored whole rather than reduced, so any
claim in the tests can be checked directly against them. They are pseudonymised
before being committed and differ from what npm served in exactly that one way —
see [test/fixtures/README.md](test/fixtures/README.md).

## Roadmap

M4 is acceptance: seven unbroken days, plus two drills — a `SIGKILL` mid-run
proving convergence with duplicates and no loss, and a full index rebuild from raw
alone. Before that, the durability debt: a second independent copy of the archive,
hash-chained manifests committed to git, and a self-imposed spend cap.

Extensions are add-only and none of them touches the recorder loop. When in doubt
between a feature and tape integrity, the tape wins.

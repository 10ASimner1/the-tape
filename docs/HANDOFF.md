# Handoff

Everything a person needs to run, debug, or take over The Tape. Written for
someone who has never seen it — including future you, at 2am, when it has stopped.

**One-line summary:** a recorder captures npm's changes feed every 15 minutes into
an append-only archive on Backblaze B2; a nightly job rebuilds a disposable SQLite
index from that archive and publishes a digest whose headline is the graveyard.

---

## 1. Where everything lives

| Thing | Where |
|---|---|
| Code | `github.com/10ASimner1/the-tape` (public, `main`, force-push blocked) |
| Working copy | `D:\VendCheck` — the folder name is historical and means nothing |
| Archive | Backblaze B2, bucket `tape-npm-archive`, region `eu-central-003`, **private** |
| Domain | `unpublished.dev` (Porkbun), forwarding `tape@` to a personal inbox |
| Liveness | healthchecks.io — pings on start/success/fail |
| Local secrets | `.env.local` (gitignored). Loaded automatically by the npm scripts. |
| CI secrets | GitHub Actions secrets, same names as `.env.local` |

Nine Actions secrets: `TAPE_PII_SALT`, `TAPE_S3_{ENDPOINT,REGION,BUCKET,KEY_ID,SECRET}`,
`TAPE_REPO_URL`, `TAPE_CONTACT`, `TAPE_HEALTHCHECK_URL`.

> **`TAPE_PII_SALT` must never change.** Every maintainer hash already in the
> archive is derived from it; a new salt silently stops them joining to anything
> recorded before. Keep an offline copy — unlike the archive, it cannot be rebuilt.

---

## 2. What it does, in one page

**The changes feed is the only irreplaceable thing.** It is queryable forward only
and nothing substitutes for it — `/-/all` is dead, `/-/rss` carries no deletions,
ecosyste.ms lags the same feed, skimdb redirects to it. Everything else in the
system can be re-fetched.

So each run does this, in this order, and the order is the entire safety argument:

```
drain the feed → COMMIT A (feed bytes durable) → COMMIT B (cursor advances)
               → fetch packuments → COMMIT C (deferred queue + manifest)
               → COMMIT D (record completion)
```

The cursor guards the feed, not the fetch queue. **Every failure window produces
duplicates; none produces loss.** This is enforced by the type system:
`cursor.advance()` requires a `FeedReceipt`, and only `writeFeedBlob()` can mint one.

**The packument is the state.** npm's `time` map is its own server-side log of
every version that ever existed, so the recorder keeps no durable per-package
state. One fetch recovers everything, including the complete unpublish history of
a package seen for the first time.

Two rules do the heavy lifting:

```js
// Every version publish — including the ~46% the feed collapses away
Object.keys(time) − {created, modified, unpublished}

// Every per-version unpublish — the malware case, for which npm sets NO marker
Object.keys(time) − {created, modified, unpublished} − Object.keys(versions)
```

The second finds `chalk@5.6.1`, `debug@4.4.2`, `event-stream@3.3.6`,
`ua-parser-js@0.7.29`, `@ctrl/tinycolor@4.1.1`. Nothing else detects them.

**The index is disposable.** Observation rows are absolute, not relative — they
record what the packument said, never a diff. So the index can be deleted and
rebuilt from `raw/obs` at any time, and any rule can be improved later and
re-applied to all of history.

---

## 3. Running it

Requires **Node 24**. Zero runtime dependencies.

```bash
npm test                  # 111 tests, against real captured packuments
npm run typecheck
node scripts/pii-audit.ts # refuses any personal address in the tree
```

| Command | What it does |
|---|---|
| `npm run store-check` | Round-trips one object. **Start here** when anything looks wrong. |
| `npm run record` | One recording run. |
| `npm run index` | OSV sync, index rebuild, digest render. |
| `npm run bootstrap -- --hours 1` | First-run cursor. Refuses to clobber an existing one. |
| `npm run recover-cursor` | Re-derives the cursor position from the archive. |

Add `--local` to use the filesystem store instead of B2.

---

## 4. When it breaks

**First move, always:** `npm run store-check`. It verifies credentials, endpoint
and signing in about a second.

**Second move:** find the last `"level":"error"` line in the run log. It names the
package and the rule.

| Symptom | What it means |
|---|---|
| `no object store configured` / `partially configured` | A secret is missing or empty. **This is deliberately fatal** — it used to fall back to local disk and silently discard the run while reporting success. |
| `PII gate refused a write to …` | A package defeated redaction. Since M2 this is recorded as a `pii_refused` gap and the run continues; if it aborts the run, that is a bug. |
| `cursor.lastSeq is ahead of the live feed head` | The cursor was clobbered forward — the one direction that loses events. Run `recover-cursor`. |
| `stored cursor has no usable lastSeq` | Corrupt cursor. Run `recover-cursor`; it re-derives from feed object keys. |
| `recovering an unfinished run from its feed blob` | Normal. A previous run died mid-fetch and this one is picking up its work. |
| `TRIAGE: queue too deep` | >50,000 packages queued. The run captures the feed only and skips fetching. Self-correcting. |
| `object store is failing more requests than usual` | B2 degradation. A ~0.3% retry rate is normal and logged at info. |
| healthchecks.io alert, no failed run | The workflow did not fire at all. See §6. |

**Nothing here is fixed by deleting the archive.** The index is disposable; the
archive is not.

---

## 5. Known holes — documented, not bugs

1. **Unpublish-then-republish inside one interval leaves zero trace.** Republishing
   clears the tombstone entirely (`left-pad` has no `time.unpublished` today). No
   polling rate fixes this. The partial signal is a `rev_gap` event: a `_rev` jump
   of ≥2 with no explained change.
2. **A 404 cannot distinguish "never existed" from "hard-purged".** The response is
   byte-identical. Only our own prior record can tell them apart.
3. **Packages that died before the tape started are gone.** Backfill would recover
   survivors' history, never the graveyard. That is why v1 shipped first.
4. **First sighting reports a package's whole history at once.** Marked
   `backfill: true` so it never counts as today's news.
5. **The feed is a single point of failure.** No mitigation exists beyond capturing
   durably and alerting loudly.

---

## 6. Operational facts worth knowing

- **GitHub drops most scheduled runs.** Measured: 2 of an expected 7 over 3.5 hours (28%), with one 213-minute gap. The cron is `7,22,37,52` to compensate — work is proportional to elapsed change, not run count, so over-scheduling is nearly free.
- **`concurrency: cancel-in-progress: false` cancels the *pending* run**, it does not queue it. Nothing may be named or keyed by wall-clock hour.
- **Backblaze returns a transient 500 on ~0.3% of writes.** Retries absorb it. Only an unusual *rate* is logged as a warning.
- **Scheduled workflows are disabled after 60 days of repo inactivity, silently.** The healthcheck is the only detector.
- **Actions minutes are free on public repos** — with standard runners only. Never a larger runner label.

### Costs

| | |
|---|---|
| GitHub Actions | £0 |
| B2 storage | £0 for roughly the first 15 months (10 GB free) |
| Domain | **~$12.87/year** — the only committed recurring cost |

Measured growth: **25 MB/day, ~9 GB/year**. The honest claim is "$0/month
infrastructure, plus a domain".

---

## 7. The rules that are not negotiable

1. **The tape wins.** Never trade recorder integrity for a feature. A single bad package must never stop a run.
2. **No personal email address is written anywhere.** Addresses become salted hashes at parse time. Enforcement is three independent layers — byte-level redaction, a gate that throws on final serialized bytes, and a repo-wide audit in CI. Never relax one to make a test pass; use an `example.com` address.
3. **The cursor never advances past feed rows that are not durable.** Enforced by `FeedReceipt`.
4. **The archive is append-only.** A wrong row is permanent, which is why derivation happens at index time where it can be corrected.
5. **Actions pinned by full commit SHA.** Tag hijacking is the attack class this project exists to record.

---

## 8. State as of 2026-08-03

**Done:** M1 (rules + loop), M2 (hourly Actions + S3 store), M3 (index, OSV join,
typosquat, digest). 111 tests. Zero runtime dependencies.

**Outstanding, in priority order:**

1. **A second copy of the archive.** Part III §6 wants two at all times, on a different provider with a different credential and billing failure domain. Right now there is one. This is the largest open risk.
2. **A no-delete B2 credential.** The recorder no longer deletes anything, so the key can now be reissued without `deleteFiles` — via the B2 API, since the web UI cannot express it.
3. **A self-imposed spend cap** (`src/budget.ts`). Object stores bill overage rather than stopping; the recorder currently cannot stop itself. Crosses the free tier around day 400.
4. **Hash-chained manifests committed to git**, so one retroactive edit invalidates every manifest after it. Without the chain it is a checksum, not a ledger.
5. **A privacy notice.** The repo is public and the project processes maintainer data at scale.
6. **M4 acceptance:** seven unbroken days, a `SIGKILL` mid-run drill, and a full rebuild-from-raw drill.

**Watch:** the scheduled-run firing rate over a full day, now that the cron is
`7,22,37,52`.

**On reviews:** M3 shipped, then an adversarial review found nine real defects in
it — including two that made the public digest quietly wrong. `backfill` is
provenance, not recency; misusing it as a filter deleted almost every
single-observation package, which is exactly the population a typosquat belongs
to. Worth repeating that exercise on anything that writes permanent rows or
publishes.

---

## 9. Where the reasoning lives

- **[`docs/assumptions.md`](assumptions.md)** — what was verified against the live APIs, when, and what it means. Read before changing any constant.
- **[`README.md`](../README.md)** — architecture and the rebuild-from-raw recipe.
- **[`test/fixtures/README.md`](../test/fixtures/README.md)** — why each fixture exists and what it proves.
- **`src/config.ts`** — every tunable, with the measurement behind it.
- **`src/index/derive.ts`** — the event rules, each with the trap it avoids.

Two constants control a 13× storage swing (`NEW_PACKAGE_WINDOW_MS` and the
retention flag list). Never tune them from a desk estimate — run the recorder and
measure bytes-per-changed-package. `docs/assumptions.md` §6 has the story.

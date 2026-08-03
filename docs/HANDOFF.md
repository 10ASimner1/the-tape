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
| Second copy | Any S3-compatible store under `TAPE_MIRROR_S3_*`, or local disk via `--mirror-local`. **Manual only** until object count comes down — see §6. **Must not be the same bucket.** |
| Hash ledger | `ledger/YYYY-MM-DD.jsonl` in this repo — the public witness to the private archive |
| Domain | `unpublished.dev` (Porkbun), forwarding `tape@` to a personal inbox |
| Liveness | healthchecks.io — pings on start/success/fail |
| Local secrets | `.env.local` (gitignored). Loaded automatically by the npm scripts. |
| CI secrets | GitHub Actions secrets, same names as `.env.local` |

Fourteen Actions secrets: `TAPE_PII_SALT`, `TAPE_S3_{ENDPOINT,REGION,BUCKET,KEY_ID,SECRET}`,
`TAPE_MIRROR_S3_{ENDPOINT,REGION,BUCKET,KEY_ID,SECRET}`, `TAPE_REPO_URL`, `TAPE_CONTACT`,
`TAPE_HEALTHCHECK_URL`. Plus one repository **variable** (not a secret, because it is
just a number and a degraded run should be explicable): `TAPE_STORAGE_CEILING_BYTES`.

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
               → COMMIT D (record completion, and the chain link for the next run)
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
npm test                  # 144 tests, against real captured packuments
npm run typecheck
npm run pii-audit         # refuses any personal address in the tree
```

| Command | What it does |
|---|---|
| `npm run store-check` | Round-trips one object. **Start here** when anything looks wrong. |
| `npm run record` | One recording run. |
| `npm run index` | OSV sync, index rebuild, digest render. |
| `npm run bootstrap -- --hours 1` | First-run cursor. Refuses to clobber an existing one. |
| `npm run recover-cursor` | Re-derives the cursor position from the archive. |
| `npm run mirror` | Copies whatever the second store is missing. **Manual only** — one Class B per object, see §6. |
| `npm run mirror -- --verify all` | Deep-verifies every object by hash, not just by size. |
| `npm run mirror -- --mirror-local D:/tape-mirror` | Mirror to disk. No second account needed. |
| `npm run restore-drill` | **The acceptance test.** Rebuilds the index from the mirror alone. Refuses to run if the primary is configured. |
| `npm run verify-chain` | Checks the hash chain from the committed ledger. **No credentials.** |
| `npm run verify-chain -- --store` | Also checks the archive's manifests against the ledger. |
| `node src/main.ts usage` | Measures stored bytes. Nightly in CI; it is the spend cap's anchor. |
| `node src/main.ts ledger --date <d>` | Transcribes a day's manifests. Always exits 0. |

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
| **`S3 GET failed: HTTP 403 AccessDenied`, but `put ok`** | **The B2 daily Class B cap is spent.** Reads 403, writes still work, so the recorder cannot read its own cursor and every run fails. It resets daily and recovers on its own — the cursor never moved, so this is delay, not loss. If it recurs, the object count is too high: see §6. |
| healthchecks.io alert, no failed run | The workflow did not fire at all. See §6. |
| `storage budget: running degraded` `tier=soft` | The archive is past 75% of the ceiling. Observations still land; only the re-fetchable packuments are skipped. Decide: upgrade the plan (`TAPE_STORAGE_CEILING_BYTES`) or stand up more space. Not urgent, but it is the warning shot. |
| `TRIAGE: storage budget exhausted` | Past 92%. **The feed is still being captured** — that never stops — but nothing is being enriched. Act now. |
| `the anchor is missing or stale` | `state/usage.json` has not been refreshed in a week, so the cap is not really enforcing. Check the nightly index job. It under-estimates when unsure, so it fails toward recording. |
| `refusing to mirror: … same object store` | `TAPE_MIRROR_S3_BUCKET` resolves to the primary. Not cosmetic: a same-bucket mirror reports "in sync" forever. |
| `mirror found N discrepancy(ies)` | Sizes differ at a key present on both sides. **Decide which side is right before running `--repair`** — in an append-only archive this means one copy is corrupt. |
| `object vanished between list and get` | The primary listed a key and could not produce it. Impossible in an append-only archive; investigate the bucket, do not retry. |
| `chain fork` | **Normal after a killed run.** The cursor kept the parent it had already used, so two manifests name it. Siblings with touching seq ranges are exactly that; the ledger says so in the line. |
| `chain missing-parent` / `chain hash-mismatch` | **Not normal.** A manifest was deleted or edited. Compare the bucket against `ledger/` in git, which is the copy an attacker cannot reach. |
| `manifest in the archive is absent from the committed ledger` | The real tamper signal. Something wrote a manifest that never reached git on the day it claims. |

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

### The limit that actually binds is requests, not bytes

**On 2026-08-03 the tape stopped at 44 MB of storage** — 0.4% of the free tier —
because Backblaze's free **Class B** allowance (2,500/day, and a `HEAD` counts) was
spent. A $0-capped account hard-stops: `GET` returns 403, `PUT` keeps working, and
the recorder cannot read its own cursor.

96% of objects were retained packuments, and each cost two Class B: a `HEAD` when
`putIfAbsent` wrote it, and a `GET` when the mirror copied it. Rescheduling could
not help — the mirror must `GET` each object exactly once regardless of when — so
the fix was to cut object count.

**Retained packuments are now batched into shards**, one set per run under
`private/packuments/`. MEASURED on 297 real packuments: 6 objects instead of 297.
The `HEAD` is gone with them, because a shard key is unique per run and is written
with a plain `put`. `docs/assumptions.md` §5 has the numbers.

**`mirror.yml` is still manual-only** until one measured day confirms the new
rate — and its first scheduled run will have a backlog to catch up, so use
`--max-objects` or seed locally.

### Costs

| | |
|---|---|
| GitHub Actions | £0 |
| B2 storage | £0 for roughly the first **9 months** (10 GB free) |
| Second copy | £0 on another provider's free tier — but it is a second free tier, so it fills at the same rate |
| Domain | **~$12.87/year** — the only committed recurring cost |

Measured growth: **35.8 MB/day, ~13.1 GB/year** — 1,711 gzipped bytes per changed
package at ~20,900 changed packages/day. 10 GB decimal ÷ 35.8 MB is **279 days**.

> This block used to say 25 MB/day, ~9 GB/year, 15 months and "day 400", and
> `README.md` said 36 MB/day and 9 months. They cannot both be right, and
> `docs/assumptions.md` §6 — the only one that shows its unit measurement and its
> provenance — is authoritative. The old numbers are what the spend cap's
> thresholds must NOT be tuned from: run `node src/main.ts usage` and use what the
> bucket actually reports.

The honest claim is "$0/month infrastructure, plus a domain". The one caveat worth
stating: seeding the mirror is a one-off ~13 GB of egress from B2, so do it once
from a local machine with `--mirror-local`.

---

## 7. The rules that are not negotiable

1. **The tape wins.** Never trade recorder integrity for a feature. A single bad package must never stop a run.
2. **No personal email address is written anywhere.** Addresses become salted hashes at parse time. Enforcement is three independent layers — byte-level redaction, a gate that throws on final serialized bytes, and a repo-wide audit in CI. Never relax one to make a test pass; use an `example.com` address.
3. **The cursor never advances past feed rows that are not durable.** Enforced by `FeedReceipt`.
4. **The archive is append-only.** A wrong row is permanent, which is why derivation happens at index time where it can be corrected.
5. **Actions pinned by full commit SHA.** Tag hijacking is the attack class this project exists to record.
6. **The budget may never refuse `COMMIT A`.** Every other write in the system is re-derivable or re-fetchable; the feed is not. A cap that can stop capture is not a cap, it is data loss on a timer. Enforced by `tierFor()` taking a `FeedReceipt` it never reads — only `writeFeedBlob()` can mint one, so moving the cap earlier is a compile error.
7. **The mirror never writes to the primary, and never repairs on its own.** Differing bytes at one key mean one copy is corrupt, and which one is a human decision.

---

## 8. State as of 2026-08-03

**Done:** M1 (rules + loop), M2 (hourly Actions + S3 store), M3 (index, OSV join,
typosquat, digest), and the durability debt — a second copy, a hash-chained ledger
in git, and a graded spend cap. 144 tests. Zero runtime dependencies.

**Do this before the mirror does anything in CI:**

> **Create the second bucket and add the five `TAPE_MIRROR_S3_*` secrets.** Until
> then `mirror.yml` fails loudly every night. That is deliberate — a backup job
> that exits zero having backed up nothing is the exact failure this project has
> already made once. Seed it locally first: `npm run mirror -- --mirror-local
> D:/tape-mirror` does the initial ~13 GB off a metered connection and proves the
> copy path before you depend on a provider you have never tested.

**Outstanding, in priority order:**

1. **A no-delete B2 credential**, and a separate **read-only** one for the mirror job. The recorder never deletes and the mirror only reads the primary, so both can be reissued with narrower scopes — via the B2 API, since the web UI cannot express it. Point `mirror.yml`'s `TAPE_S3_KEY_ID`/`SECRET` at the read-only key and that job loses the ability to touch the archive at all.
2. **A privacy notice.** The repo is public and the project processes maintainer data at scale.
3. **Re-derive the storage constants from `usage`.** `node src/main.ts usage` now reports real stored bytes per prefix. The budget's soft/hard fractions should be tuned against that, never against §6 — those are the constants this project already got wrong by 13× from a desk estimate.
4. **A whole-archive PII sweep.** README still says one does not exist. The daily mirror is the only job that reads every object, so it is nearly free to add there.
5. **M4 acceptance:** seven unbroken days, and a `SIGKILL` mid-run drill. The rebuild-from-raw drill is now a command: `npm run restore-drill`.

**Watch:** the scheduled-run firing rate over a full day, now that the cron is
`7,22,37,52`. And the `storage` row in each run's step summary — it is printed on
every run, not only degraded ones, precisely so the number is watchable before it
becomes a problem.

**Watch harder:** the B2 **Class B transaction** count, which is the binding
constraint and is not the one anything in this repo measures. See §6 — the spend
cap in `src/budget.ts` guards stored BYTES, and bytes turned out not to be what
runs out first.

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
- **`src/ledger.ts`** — the hash chain, and what each kind of break actually means. Read before treating a fork as an incident.
- **`src/budget.ts`** — the graded cap, and why it structurally cannot refuse `COMMIT A`.
- **`src/mirror.ts`** — the second copy, and why it holds no resume state.

Two constants control a 13× storage swing (`NEW_PACKAGE_WINDOW_MS` and the
retention flag list). Never tune them from a desk estimate — run the recorder and
measure bytes-per-changed-package. `docs/assumptions.md` §6 has the story.

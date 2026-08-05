# Session handoff — 2026-08-05

**This is a session handoff: where the work got to, and how to pick it up cold.**

For *operating* the system — runbook, error-message lookup, known holes, the
non-negotiable rules — read **[`docs/HANDOFF.md`](docs/HANDOFF.md)**, which is a
different document and remains authoritative. This one is about the state of the
work, not the state of the machine.

Also worth reading before touching anything: **[`docs/incidents.md`](docs/incidents.md)**,
which is new and records the three things that went wrong in the last three days.

---

## 1. Goal

**The Tape** records npm publish, update and — critically — **unpublish** events
into an append-only archive. Unpublished packages vanish from every public
record; every day not recorded is lost forever.

The work in this session had one starting objective and acquired two more:

1. **Pay off the durability debt** (the original ask). Three items `README.md`
   grouped under that name and which blocked M4 acceptance: a second independent
   copy of the archive, hash-chained manifests committed to git, and a
   self-imposed spend cap.
2. **Get the tape running again**, after it stopped on 2026-08-03 — at 44 MB of a
   10 GB tier, because Backblaze's free **Class B** transaction allowance
   (2,500/day, and a `HEAD` counts) was exhausted.
3. **Audit whether it is actually working**, which surfaced a live PII leak and a
   second cost cliff.

The standing constraints all of this operates under are in `docs/HANDOFF.md` §7.
The two that bind hardest: *the tape wins* (never trade recorder integrity for a
feature), and *no personal email address is written anywhere*.

---

## 2. Current state

### Healthy

- **Recorder: 17 consecutive successful runs**, 2026-08-04T01:10 → 08-05T11:38.
- **Class B per recorder run is exactly 3**, with zero variance, while `fetched`
  ranged 1,938–8,639 and one drain hit 22,746 rows. Cost no longer scales with
  work. It was ~1,650/day.
- **Backlog drained** 17,360 → 52 deferred rows and stayed flat.
- **Total Class B ≈ 192/day against 2,500** (7.7%).
- **163 tests**, 56 suites, all passing. Zero runtime dependencies. Node 24.
- `main` is clean and in sync with `origin/main`.

### Broken or at risk

| item | status | clock |
|---|---|---|
| Nightly `publish` job | **Fails every night.** Branch protection rejects the bot's push. | Accrues nightly, **irreversibly** |
| Egress | Index downloads the whole archive nightly: 180.5 MB, +79–130 MB/day | **Crosses 1 GB/night ~Aug 11–16** |
| Second copy | `mirror.yml` and `drill.yml` have **never run**. 89.9% of the archive (394 MB) exists in one bucket | Standing risk, no clock |
| 4 leaked `raw/osv/` objects | Still carry 1,022 personal addresses | Needs operator action |
| Class B growth | Index adds +43/night | ~2026-09-30 |
| Storage | ~204 MB/day, not the documented 35.8 | Soft budget rung ~2026-09-09 |

### Two numbers the docs still get wrong

`docs/assumptions.md` §6 says **20,900** changed packages/day and **1,711 B**
each. Measured: **~55,100** and **~3,708 B** — the projection omitted retained
packuments, which are 48% of the bill. 35.8 MB/day is really **~204**. This is
not yet corrected, and `TRIAGE_THRESHOLD`, the shard sizing and the storage
runway are all derived from those two numbers.

---

## 3. Active files

For the next piece of work (incremental index — §6 step 1):

| file | why it matters |
|---|---|
| `src/index/build.ts` | The whole change lands here. `opts.since` exists at :76 and **no call site passes it**. `prior` is rebuilt from scratch every run at :127 — that is the blocker, not the flag. |
| `src/index/schema.sql` | Needs `packages.maintainer_hashes`. It is the one `PriorState` field the DB cannot already supply. |
| `src/index/derive.ts` | The contract `prior` must satisfy. `:218`'s `before.length > 0` guard is the trap — an empty-hash rehydration silently drops every `maintainer_change`. |
| `src/main.ts` | `:255` and `:410` call `build(store, dbPath)` with no `since`. |
| `.github/workflows/index.yml` | Where `actions/cache` goes. Its two-job privilege split must survive: `build` holds credentials and cannot write the repo; `publish` holds `contents: write` and no credentials. |
| `test/build.test.ts` | **Does not exist.** `build()` has never been tested end to end. |

Recently changed and load-bearing — read before touching:

| file | what to know |
|---|---|
| `src/jsonl.ts` | `putJsonl`'s guard is now a **required** parameter. That is deliberate; see §5. |
| `src/pii.ts` | `EMAIL_RE`'s quantifiers are bounded to RFC 5321 limits, not cosmetically. |
| `src/run.ts` | The commit ordering is the entire safety argument. Packument retention now writes shards via `pkgShards`, guarded with `assertNoPersonalAddresses` — **never** `assertNoPII`. |
| `src/ledger.ts` | `readManifests` must default every manifest field. Three schema eras coexist in the bucket. |
| `src/budget.ts` | `tierFor` takes a `FeedReceipt` it never reads, so the cap cannot be evaluated before the feed is durable. Do not "clean that up". |
| `src/mirror.ts` | Read-only on the primary by construction. Two known bugs listed in §6. |

---

## 4. Changes made

Sixteen commits, `5af2307..1a9c907`, all pushed. CI green.

**The durability debt (the original goal) — all three shipped.**

- `f59ae1d` Byte accounting made real (`rows * 100` was measuring raw bytes of a
  gzipped object). Fixed two latent bugs: every `deferred` gap row ever written
  was buffered after the final flush and discarded, and `index` mode clobbered
  the cursor via a lost update.
- `f88a5df` Manifests hash-chained and transcribed to `ledger/*.jsonl` in git.
  The verifier classifies rather than detects — a *fork* (normal after a killed
  run) is not a *break* (a deletion) is not a *hash-mismatch* (an edit).
- `259e86c` Second archive copy: `mirror` mode, read-only on the primary,
  resumable with no state, plus `restore-drill` which refuses to run while the
  primary is configured.
- `50e1b11` Graded spend cap. Soft narrows retention by irreplaceability; hard
  reuses the existing triage path.

**The Class B outage.**

- `fb78f34` Corrected the wrong claim that caused it, and stopped the mirror cron.
- `9695b02` Batched retained packuments into shards — **1,704 objects → 18** on
  real data. Also bounded `EMAIL_RE`, which backtracked quadratically (4.3 s on
  100 KB) and could have stalled a run into the workflow's `SIGKILL`.
- `fd91ad0` Raised shard caps after measuring that observations bound on *rows*
  at 227/250 while using a third of their byte budget. Added per-class
  transaction counters, so the binding constraint is finally measured.

**The audit findings.**

- `3251eea` **The OSV path wrote 1,022 raw personal addresses** — the only
  `putJsonl` caller without a guard. Fixed, and the guard is now required.
  Also fixed a `TypeError` in `readManifests` that killed a whole night's build.
- `c9bfc51` The PII gate leaked an address *while refusing one* — a
  percent-encoded address was not masked in the error message and reached a
  public workflow log.
- `e187de9` Started `docs/incidents.md`.
- `5cde884`, `cbeba3f` Recovered the expiring digest/ledger artifacts and
  backfilled the 08-03 ledger. **`ledger/` exists in the repo for the first
  time.** The two files prove contiguous seq coverage across a day boundary
  (08-03 ends at 123005130; 08-04 begins at exactly 123005130).
- `cfb1504` Digest yank count **3,425 → 80**. It was counting a package's entire
  history as today's news.
- `1a9c907` OSV redacted on ingest too, so the index cannot inherit the leak.

---

## 5. Failed attempts

Kept because each one cost time or shipped a defect, and the reasoning is the
useful part.

**Claimed no credential could delete.** Stated it twice, including in a commit
message. The `tape-recorder` key holds `deleteFiles`, `writeBuckets` and
`writeBucketLifecycleRules`. What is true is that no *code path* deletes —
`.delete(` has zero call sites. I read the intention recorded in `docs/HANDOFF.md`'s
outstanding list as a description of the state. **Same failure as the docs saying
B2's Class A/B/C transactions were free**, which is what caused the outage in the
first place: a doc recording what was *meant*, quoted back later as what *is*.

**Proposed mirroring `private/` on a slower cadence, calling it a 95% saving.**
It is a 0% saving. The mirror must `GET` each object exactly once, ever, so its
cost is set by object count and cannot be rescheduled away — deferring just
concentrates the same total onto one worse day. Caught before implementing.

**Piped `npm run pii-audit` through `tail` inside an `&&` chain.** The shell
reported the pipeline's exit code, not the audit's, so a **failing PII audit
reached `main`** (`fbebde5` fixes it). A verification step whose exit code is
masked is not a verification step.

**Used a real-looking domain in a test.** The repo-wide audit correctly refused
it. Rule 2 says use `example.com`; there is no version of "just for a test" that
survives contact with that rule.

**Tried `If-None-Match: *` against B2** hoping conditional writes would remove
the `HEAD` in `putIfAbsent`. Returns **501 NotImplemented**. Correctly abandoned;
the answer was to batch instead. The probe cost two Class A requests and settled
a question the code comments had assumed.

**Reversed the yank table's ordering to show the most-yanked first.** Reverted.
The fewest-first ordering has a measured rationale I had not read: a bot yanking
400 versions is a fact about the bot, and two Atlassian test packages once
produced 46 of the top 50 rows. Ordering handles noisy bots; the backfill filter
handles history. They are not substitutes.

**Reported both nightly index failures as branch protection.** Only 08-05 was.
08-04 was **my own `TypeError`** from the ledger commit — `manifest.retained.length`
on manifests written before that field existed. `manifest.ts` claimed both eras
satisfied the arithmetic and forgot the era before `retained` existed at all.
*In an append-only archive every shape ever written stays readable forever. Count
the eras, then default anyway.*

**Reported that `state/usage.json` had never been written.** It had — by the
`build` job, which holds the credentials and succeeded. The spend cap was
anchored and enforcing the whole time.

**Raised the shard caps without checking which constraint I was trading
against.** It fixed the request wall and pulled the **egress** wall ~4× closer,
because mean shard size went 384 KB → 1.56 MB. `docs/assumptions.md` still says
B2 is "a REQUEST limit long before it is a byte limit"; at current sharding,
bytes bind first, by about six weeks. The fix was right; the analysis was
one-dimensional.

**Considered passing `opts.since` to make the index incremental — it would be
strictly worse than today.** On CI the DB starts empty every night, so a window
would produce a DB containing only that window, silently degrading
`securityHolders`, `resurfaced`, the typosquat join and every cumulative count.
Persisting the DB is the prerequisite, not the optimisation.

---

## 6. Next steps

### Step 1 — make the nightly index incremental *(the deadline item)*

Egress crosses 1 GB/night **between Aug 11 and Aug 16**. `src/budget.ts` cannot
catch it: its ladder degrades what is *written* and has no term for what is
*read*. At `hard` tier the index would still download the whole archive.

In dependency order:

1. **Persist the DB via `actions/cache`** — not the bucket, where keep-all-versions
   would retain a full copy nightly. Correctness must never depend on the cache: a
   miss means a full rebuild, which is exactly today's behaviour.
2. **Rehydrate `prior` from the DB.** `maintainers` ← `packages.maintainers`
   (already has the right COALESCE semantics). `revInt` ← `observations.rev_int`
   filtered on `outcome IN ('ok','tombstone')`. `times` ← the all-time `publish`
   version set from `events`, a superset that can only suppress emissions
   `INSERT OR IGNORE` would have swallowed anyway.
3. **Add `packages.maintainer_hashes`.** `schema.sql`'s header already states
   hashes are acceptable, so this is consistent with the stated policy. **Do not
   ship a rehydration that leaves hashes empty** — see §3.
4. **Watermark in `build_meta`**, applied **strictly greater**, not `>=`. Each
   shard is then processed exactly once ever, which sidesteps the non-idempotent
   writes below rather than requiring them fixed first.
5. **Bound the OSV pass** (`build.ts:202-215`) — `since` does not cover it.
6. **Write `test/build.test.ts`.** The load-bearing test is *equivalence*: build
   fully, build incrementally, assert the `events` tables are identical. Run
   against `D:/tape-mirror` so it costs nothing.

### Step 2 — re-enable the mirror

**89.9% of the archive is single-copy.** Largest standing risk in the system. It
is second only because catching up costs ~394 MB egress and ~238 Class B, which
collides with step 1's cliff. Use `--max-objects` to spread the seed and **not**
`--verify all` (1,960 extra GETs). Fix two bugs while there: `writeState` re-lists
every prefix a second time, and `--verify` falls back to sampling the whole
archive when nothing was copied.

### Step 3 — correct `docs/assumptions.md` §6 and what derives from it

See §2. Also correct the "requests bind before bytes" claim.

### Known and deliberately deferred

- `gaps` has no primary key; `packages.observations` is a raw `+1`;
  `osv_affects` has a nullable `version` in its PK so `INSERT OR IGNORE` never
  fires — **834 duplicated pairs already exist**. A strictly-greater watermark
  means none of these bite, but they are real.
- `pii_refused` observation rows are dropped *and* never retried.
- A whole-archive PII sweep still does not exist. The mirror is the only job that
  reads every object, so that is where it belongs.

### Waiting on the operator

**GitHub, ~5 min.** Replace classic branch protection with a **ruleset**
requiring the same `test` check plus a bypass actor for the GitHub Actions app,
**id 15368** (verified; it is the same app id already named in the existing
required-check config). Classic protection has no per-actor bypass, which is why
this needs converting rather than toggling. Note `GITHUB_TOKEN` pushes do not
trigger workflows, so the required check can never appear on a bot commit by
itself — a PR-based workaround hits the same wall.

**Backblaze.** Confirm the **download/egress** allowance on Caps & Alerts; the
1 GB/day figure sets step 1's deadline and came from the account rather than from
documentation. And decide on the four leaked `raw/osv/` objects —
`docs/incidents.md` has the remediation open, and note that on a keep-all-versions
bucket an ordinary delete only writes a delete marker.

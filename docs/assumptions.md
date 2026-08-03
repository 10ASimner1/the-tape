# Verified assumptions

Everything below was measured against the live APIs, not read from documentation.
Dates matter: npm has changed its replication API before and will again.

**Measured 2026-08-02** unless noted. Re-measure before trusting any number here.

---

## 1. The changes feed

`GET https://replicate.npmjs.com/registry/_changes?since=<int>&limit=<n>` → **200**.

```json
{"results":[{"seq":122876690,"id":"@skein-js/nextjs","changes":[{"rev":"11-721a…"}]}],"last_seq":122876705}
```

- **`seq` is a plain integer**, monotonic, but **sparse**: ~3–6 seq units per emitted row, and the ratio drifts. Never size anything from a seq delta.
- **Unpublishes carry `"deleted": true`.** The field is *absent* on ordinary publishes, so test with `=== true`, never `!== false`. ~15–25/day.
- **Rejected with HTTP 400:** `include_docs`, `feed`, `heartbeat`, `timeout`, `style`, `filter`, `since=now`. Not using `include_docs` is the only option, not a preference.
- **`limit` caps at exactly 10000** (10001 → 400).
- **Bootstrap** reads `update_seq` from `https://replicate.npmjs.com/` — `since=now` is a 400.
- No auth, no rate limiting observed (30 parallel requests all 200). `Cache-Control: max-age=14400`.
- **Responses are deterministic** — identical queries return byte-identical bodies. This is what makes the archive verifiable after the fact.

npm narrowed this feed in Feb 2025 (deprecation completed 2025-05-29). The design here is exactly the post-migration pattern npm recommends.

### The feed coalesces — this is the single most important finding

A full 24-hour enumeration returned **20,892 rows / 20,892 distinct names / max 1 row per package**. Packument sampling shows **1.84 versions published per changed package**. So **~46% of version-level events never appear as feed rows** — a package publishing five versions between two runs appears once.

Recovering them requires the packument's `time` map. See §2.

### There is no substitute source

`/-/all` → 404 (dead since 2017). `/-/rss` → 50 items, zero deletions. `packages.ecosyste.ms` → a lagging mirror of this same feed. `skimdb.npmjs.com` → 301 to `replicate.npmjs.com`.

**This feed is a genuine single point of failure for unpublish detection.** No mitigation exists beyond capturing durably and alerting loudly.

---

## 2. The registry

### A fully unpublished package returns 200, not 404

50/50 sampled deleted ids returned a **tombstone**: `{_id, name, _rev, time, maintainers}` — no `versions`, no `dist-tags`.

- **`time.unpublished` has two live shapes.** Minimal `{time, versions}` and legacy `{name, time, tags, versions, maintainers}`. 29 of 40 historical samples were legacy; all 2022+ ones were minimal. A type requiring all five crashes on ~28% of tombstones.
- **`unpublished.name` is the unpublishing USER's npm username**, not the package name (`cjhooker-test` → `cjhooker`).
- **`time.modified` is NOT the unpublish time.** `nethix` reads modified `2026-08-01` but unpublished `2022-03-11` — the feed re-emits ancient deletions. Always use `time.unpublished.time`.
- `unpublished.versions` is sorted **lexicographically** and may be a **subset** of the versions the package ever had.

### Per-version unpublish sets nothing at all

The malware case. Every historically-compromised package returns 200, a normal packument, and `time.unpublished === undefined`. The only signal is a set difference:

```js
Object.keys(time) − {created, modified, unpublished} − Object.keys(versions)
```

Verified with **zero false positives** against clean controls (`left-pad`, `lodash`, `compresion`):

| package | yanked versions |
|---|---|
| `chalk` | 5.6.1 |
| `debug` | 4.4.2 |
| `event-stream` | 3.3.6 |
| `ua-parser-js` | 0.7.29, 0.8.0, 1.0.0 |
| `coa` | 6 versions |
| `rc` | 1.2.9, 1.3.9, 2.3.9 |
| `@ctrl/tinycolor` | 4.1.1, 4.1.2 |
| `flatmap-stream` | 11.1.1 |

Computable from a **single fetch**, so first contact with a package recovers its entire unpublish history.

**One subtlety found while building:** a tombstone's `versions` map is empty, so *every* version reports as missing. `nethix` would emit 19 spurious version-unpublish rows on top of its one real death. A tombstone is one event, not N.

### Security-holding packages have no machine-readable marker

Every single-signal rule has real false positives:

- The description `"security holding package"` is imitated verbatim by **Yandex, Epic Games and Haufe-Lexware** on packages npm never touched.
- `maintainers == npm@npmjs.com` covers **1,624 packages**, including takeovers like `compresion` that keep entirely normal content.
- Even the version name is forgeable: **`crossenv@0.0.1-security` was published by the attacker** from npm's own security-holder template.

Working rule is a conjunction, recorded with a confidence rather than a boolean:
`dist-tags.latest` matches `/-security$/` **and** `versions[latest].repository.url === 'git+https://github.com/npm/security-holder.git'` **and** maintainers contains `{name: 'npm', email: 'npm@npmjs.com'}`.

### Other registry facts

- **`ETag` + `If-None-Match` works** (304). **`If-Modified-Since` is ignored** — sending it wastes the round trip.
- **Abbreviated packuments are disqualified.** 2.4–3.6× smaller and structurally email-free, but they have **no `time` map**, so no publish recovery and no yank detection. Wire saving is only ~20% anyway.
- Packument sizes gzipped: **mean 165 KB, median 9.1 KB, p90 279 KB, max 4.88 MB**. Brutally heavy-tailed.
- No rate limiting hit at 30 rps across 300 distinct names. npm's acceptable-use post allows ~5M requests/month; this design uses ~626k.

---

## 3. OSV

`POST https://api.osv.dev/v1/querybatch` works: no key, no documented rate limit, max 1000 queries, results positionally aligned, IDs only. Querying by **package name alone** returns MAL records.

**A better path exists.** `https://storage.googleapis.com/osv-vulnerabilities/npm/modified_id.csv` (8.4 MB) is sorted **reverse-chronologically**, so a ranged GET of the first few KB yields every record changed since the last run:

```
curl -r 0-400 https://storage.googleapis.com/osv-vulnerabilities/npm/modified_id.csv
2026-08-02T19:49:31Z,MAL-2026-11430
2026-08-02T03:56:49Z,GHSA-xg6x-h9c9-2m83
```

### Enrichment cannot be write-once

Measured on the 130 most recent npm MAL records, lag from npm publish to the record being **retrievable**:

| percentile | lag |
|---|---|
| median | **3.07 h** |
| p90 | 3.8 h |
| max | 12.7 h |
| outlier | **128 days** |

OSV's `published` field is misleadingly fast (median ~2 min) — **`import_time` is the real number**. Enriching at first sight misses ~90% of hits.

Also: **~11% of recent MAL packages already 404** at the registry. The takedown is exactly what makes them interesting, so a 404 must be a recordable outcome, never an error.

---

## 4. Downloads / popularity

- Bulk cap is **exactly 128** — the API says so: `exceeded max bulk size of 128`.
- **Scoped packages are hard-rejected in bulk** (`scoped packages are not currently supported in bulk lookups`). One scoped name 400s the whole batch.
- Undocumented rate limit: **429 at request 44** (~2.3 req/s), with a useless `Retry-After: 0`.
- A top-5000 ranking needs **~1,816 requests** (~30 min), because 35.8% of the list is scoped. It cannot live in the hourly job.
- Seed list: **`wooorm/npm-high-impact`** — MIT, pre-ranked, 17,338 names. Pin by commit SHA.
- `nice-registry/all-the-package-names` is fresh and complete but declares **no licence** — do not redistribute.

---

## 5. Platform

- **GitHub Actions is free and unlimited on public repos** — *standard runners only*. Never a larger runner label.
- Scheduled runs are documented as **delayed or dropped**, worst at the top of the hour. Nothing may be named or keyed by wall-clock hour.
- **`concurrency: cancel-in-progress: false` cancels the pending run** — it does not queue it.
- Scheduled workflows are disabled after 60 days of "repository activity", which GitHub never defines. Disabling is **silent**. External liveness monitoring is the only reliable detector.
- **Cloudflare R2 requires a payment method** and **bills overage rather than hard-stopping** (unlike D1/KV). Backblaze B2 gives 10 GB free with **free** Class A/B/C transactions.
- **The 10 GB is CUMULATIVE STORAGE, not a monthly write allowance,** and it is quoted in **decimal** GB. Both matter to `src/budget.ts`. The archive is append-only, so every byte ever written is still being billed for — a monthly write counter reads near-zero on the very day the tier is exhausted. And reading a decimal tier as binary would overstate the headroom by 7.4%.
- **Free Class B/C transactions are what make the mirror's design possible.** Listing a year-end archive is ~950 pages per side and costs nothing, so the mirror recomputes a full diff every run rather than keeping a watermark. That matters beyond cost: `private/pkg/<name>/<rev>` keys carry no date component, so a new key can appear anywhere in the keyspace at any time and a lexical high-water mark there would skip writes silently.
- **npm explicitly permits this.** Its crawler policy: full metadata via CouchDB replication *"is acceptable within our terms of use"*.

---

## 6. Volume and storage — measured from this recorder

Registry-wide rates, measured by enumeration:

| quantity | value |
|---|---|
| changed packages / day | ~20,900 (~870/hour) |
| version-level publish events / day | ~38,400 |
| brand-new packages / day | ~3,000–3,500 (16.7% of changes) |
| **scoped** share of changed packages | **77.5%** |
| install scripts on latest | 1–2% |
| packuments at concurrency 5 | 85 s for 870 — runtime is a non-issue |

Storage, measured from real runs of this code:

| | per changed package (gz) | projected |
|---|---|---|
| first attempt | 22,448 B | **469 MB/day**, 171 GB/yr ❌ |
| after fixes | **1,711 B** | **35.8 MB/day**, 13.1 GB/yr ✅ |

### What the first live run taught us

Two things no amount of desk analysis had surfaced:

1. **`@atlassian-test-prod/synth-check` carries 22,603 versions, 17,114 of them unpublished.** Uncapped, that is a single **453 KB** observation row, and it alone would have dominated the daily graveyard. `@agentconnect.md/daemon` published **537 versions in 30 days** → a 245 KB row. Both lists are now capped, with the true totals preserved alongside so nothing is understated.

2. **"New package" must mean 48 hours, not 30 days.** At 30 days, 30% of changed packages qualified (against a measured 16.7%) — and the ones wrongly caught were established churning packages averaging **44 KB** per packument rather than the 3.4 KB a genuinely new package costs. This one constant was the difference between 469 MB/day and 36 MB/day.

Retention now fires on ~11% of changed packages at a mean of 3.2 KB.

### Re-measure before trusting these against the spend cap

Two caveats on the 1,711 B figure, both introduced by later work:

1. **It was derived from a `bytesWritten` that estimated the feed blob** as
   `rows * 100` — a raw-byte figure applied to a gzipped object, over-counting
   stored bytes roughly 3× — and that omitted the manifest entirely. Both are
   fixed, so the number the recorder now reports means something different from
   the number that produced this table.
2. **Manifest overhead is cadence-dependent** (~2–8 KB per run), so it scales with
   GitHub's scheduled-run firing rate, which is measured at 28%.

`node src/main.ts usage` lists the bucket and reports real stored bytes per
prefix. **Set `BUDGET_SOFT_FRACTION` and `BUDGET_HARD_FRACTION` from that, not
from this section** — the storage constants above are exactly the ones this
project already got wrong by 13× from a desk estimate.

Note also that these figures are for ONE copy. The archive is now mirrored, so
total stored bytes across both providers is double — on two independent free
tiers, which is the point, but they fill at the same rate.

3. **Redaction has two failure directions, and both fired.**

   *Under-redaction:* retained packuments were being stored **verbatim**, so a single
   test run put real maintainer addresses into the archive, and the committed test
   fixtures carried **229 distinct addresses across 10,225 occurrences** — the exact
   bulk contact corpus the policy exists to prevent, in a repo intended to be public.
   The row-level gate never saw any of it, because it only ran on the JSONL writes.
   This is why the gate now runs over *every* write and why a whole-archive sweep is
   part of verification.

   *Over-redaction:* the first fix then destroyed data. `git@github.com` matches any
   sane email pattern, and it is the local part of every SSH clone URL npm carries in
   `repository.url` — so redaction silently corrupted every repository URL in the
   fixtures. Over-redaction destroys data just as permanently as under-redaction
   leaks it. Service addresses (`git@`, `hg@`, `svn@`, and `npm@npmjs.com`) are now
   explicitly exempt.

   Also found while fixing this: **npm data contains malformed address fields.**
   `ua-parser-js` has a maintainer whose `email` value is two addresses concatenated
   with no separator. Anything that parses fields rather than scanning bytes would
   have treated that as one malformed address and passed it straight through.

---

## 7. Known holes

These are documented rather than engineered around, because they cannot be closed:

1. **Unpublish-then-republish inside one interval leaves zero trace.** Republishing clears the tombstone entirely — `left-pad` has no `time.unpublished` today despite being the most famous unpublish in npm history. No polling rate fixes this. The `revInt` jump is a partial signal: a gap of ≥2 with no explained change means mutations we could not account for.

2. **A 404 cannot distinguish "never existed" from "hard-purged".** The body is byte-identical. Only our own prior record can tell them apart — which is the argument for the archive, and also a limit on it.

3. **Packages that died before the tape started are gone.** Backfill recovers survivors' history, never the graveyard. That is why v1 shipped first.

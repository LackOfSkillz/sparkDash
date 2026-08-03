# Showcase: real prompt mode and safe archival

**Status:** implemented · **Scope:** development instrument only

Showcase exists to demo throughput. This change makes it additionally usable for
one narrow development purpose: running genuine LineWright prompt packets
locally, unmodified, without letting large runs inflate the history file.

> Prompt hashes prove **byte identity** only. They do not prove semantic
> equivalence, model determinism, or provider cache use.

> Large runs may be available for copying while active but are intentionally
> unavailable for Reuse after archival.

---

## Why 4,000 characters blocked real experiments

The old rule was one constant:

```js
const MAX_PROMPT_LEN = 4000;   // and it measured prompt.length
```

Two problems.

A real LineWright prompt carries the whole scene manuscript — the measured proof
packet is 3,703 bytes for a toy scene and runs to tens or hundreds of kilobytes
for real ones. So the ceiling did not merely constrain the experiment; it made it
impossible, and anything that fit would have been a synthetic miniature whose
results say nothing about prompts two orders of magnitude larger.

`prompt.length` is also not a size. A curly quote, an em dash, and a CJK
character are each one JavaScript character and three UTF-8 bytes; an emoji is
one or two characters and four bytes. Everything here is measured with
`Buffer.byteLength(text, "utf8")`.

## Why raising the limit needed the storage change first

Archival serialized every prompt and every output into ONE JSON file and rewrote
the whole thing on each archive. The worst case at the new per-prompt ceiling:

```
prompts        4 MiB × 32 streams × 20 runs   = 2,560 MiB
content        ~32 KiB × 32 × 20              =    20 MiB   (content cap)
reasoning      ~32 KiB × 32 × 20              =    20 MiB
                                              -----------
                                                ~2.5 GiB before JSON escaping
```

Then `JSON.stringify(out, null, 2)` builds that entire string in memory before
writing, and 2-space indentation adds to it. Node's maximum string length is
**536,870,888 characters** — so the write would throw, the existing `try/catch`
would log `failed to save history`, and persistence would stop **silently**.
`atomicWrite` also writes a temp file and renames, so disk pressure is doubled
transiently.

This is not a theoretical risk. It is the reason the limit could not simply be
raised.

## Two independent budgets

| Budget | Question it answers | Limits |
|---|---|---|
| **Request** | What may a run *send*? | per-prompt, per-session |
| **Archive** | What may a run *persist*? | per-session body |

A run may legitimately exceed the archive budget and still be worth running. It
is then archived as metadata only.

### Environment variables

| Variable | Default | Meaning |
|---|---:|---|
| `SHOWCASE_MAX_PROMPT_BYTES` | 4 MiB | Largest single prompt |
| `SHOWCASE_MAX_SESSION_PROMPT_BYTES` | 16 MiB | Largest combined prompt input |
| `SHOWCASE_MAX_HISTORY_BODY_BYTES` | 1 MiB | Largest body persisted per run |
| `SHOWCASE_HISTORY_LIMIT` | 20 | Retained runs per Spark |
| `SHOWCASE_MAX_PROMPTS` | 32 | Concurrent streams |
| `SHOWCASE_RUNS_DIR` | `<config>/showcase-runs` | Per-run body files |

Absent, unparseable, zero, and negative values fall back to the default and log a
warning — a typo in a deployment env must not silently remove a safety limit.

**The aggregate limit is deliberately not `maxPrompt × maxPrompts`.** A 4 MiB
per-prompt ceiling must not entitle a caller to 32 of them at once; 16 MiB is
what stops that.

### Validation rules

```
any single prompt  > SHOWCASE_MAX_PROMPT_BYTES          → HTTP 400, whole session rejected
sum of all prompts > SHOWCASE_MAX_SESSION_PROMPT_BYTES  → HTTP 400, whole session rejected
```

Errors name the limit and the actual byte count, identify **which** prompt when
applicable, and **never echo prompt content** — an error message is a log line,
and a log line is not where a manuscript belongs.

```
Prompt 4 is 5,284,113 bytes; the configured per-prompt limit is 4,194,304 bytes.
Combined prompt input is 18,553,921 bytes; the configured session limit is 16,777,216 bytes.
```

The Showcase start route also mounts its own `express.json({ limit })`. The
global default is **100 kb**, which previously rejected a large prompt as a bare
413 before any Showcase validation ran — the caller learned nothing about which
limit they hit. The manager's byte checks remain authoritative.

## Raw mode

`raw: true` on the start request. **Defaults to false**, so the existing
throughput demo is unchanged.

| | Demo (default) | Raw |
|---|---|---|
| Fill-to-maximum suffix appended | yes | **no** |
| `min_tokens` | `= max_tokens` | **absent** |
| `ignore_eos` | `true` | **absent** |
| `stop` | `[]` | **absent** |
| Natural EOS | forbidden | **allowed** |
| Prompt trimmed | yes (historical) | **no — exact bytes** |

Raw request body:

```js
{
  model,
  messages: [{ role: "user", content: prompt }],
  max_tokens,          // a ceiling, not a target
  temperature,
  stream: true,
  stream_options: { include_usage: true }
}
```

Thinking flags still apply from the explicit Thinking control. Temperature and
token limits are never silently changed.

**Byte preservation.** Leading indentation, trailing whitespace, blank lines,
CRLF, and Unicode all survive intact, in the browser and on the server. They
change the tokens the model sees; trimming them would mean the run measured
something that was never submitted. Validation still rejects an entirely blank
prompt — "did you send anything" is a different question from "what exactly did
you send". Non-raw keeps its historical trim.

The HTTP-400 retry that strips `min_tokens`/`ignore_eos` is guarded on those
fields being present, so raw mode never enters it.

## Prompt identity

Every stream carries:

```js
promptIdentity: {
  submittedHash,        // SHA-256 of exactly what the caller sent
  submittedByteLength,
  effectiveHash,        // SHA-256 of what was actually sent to the model
  effectiveByteLength,
  mutated               // true when Showcase altered the prompt
}
```

Two hashes because non-raw mode mutates the prompt server-side. Recording one
would make a run irreproducible from its own record: you could not tell whether a
difference came from your edit or from the server's.

```
raw       → submittedHash === effectiveHash, mutated === false
non-raw   → hashes differ,                   mutated === true
```

## History index versus per-run files

```
config/showcase-history.json            index: summaries, metadata, hashes, byte counts
config/showcase-runs/<sparkId>/<sessionId>.json   full body, when retained
```

The index keeps per-stream `streamMeta` — identity, status, byte lengths,
timings, errors, and a bounded 40-character label — and drops `prompt`,
`content`, and `reasoning`, which are the only fields that scale with the
manuscript.

**A body exists in at most one persisted place.** The index never duplicates it.

Paths are derived only from sanitized ids (`[^a-zA-Z0-9_-]` → `_`, capped at 128
chars). A whitelist, not a blacklist: `..` cannot survive it because `.` is not
in the allowed set. Everything stays under one configured root.

### Retention states

```js
{ state: "full",          runFile, retainedBytes, originalBytes }
{ state: "metadata-only", reason: "session-body-limit", retainedBytes: 0, originalBytes, limitBytes }
{ state: "unavailable",   reason: "run-file-missing-or-unreadable" }
```

Bodies are **either retained complete or not at all**. A truncated prompt
presented as the prompt would make every later comparison a lie.

`unavailable` is reported when the index says bodies were kept but the file is
missing or malformed. The route returns the summary with a sanitized reason; it
does not crash and does not remove the index entry.

### Body accounting

Recorded on every archived run, from exact UTF-8 bytes:

```js
{ promptBytes, contentBytes, reasoningBytes, totalBodyBytes }
```

Deliberately not JSON-encoded length: escaping overhead varies with content, and
a threshold that moved with punctuation would be impossible to reason about.

## Cleanup

- **Clear history** removes the Spark's index entries *and* its run directory.
  Scoped to that Spark — another Spark's runs are untouched. An active run is not
  cancelled.
- **Retention eviction** removes the evicted run's body file. Dropping the index
  entry alone would orphan the file forever, which is how a "bounded" store grows
  without bound.
- **Re-archiving the same session id** overwrites rather than accumulating. A run
  that grows past the limit on re-archive has its stale full body deleted, so a
  `metadata-only` record never sits beside a full body on disk.
- **Missing files are success**, not an error.

### Legacy index migration

An index written before this change carries inline bodies. On load each such
record is migrated into a run file (or to `metadata-only` if too large) and the
index is rewritten once. Nothing is silently discarded — a run too big to keep
records its original size.

## Live sessions

An active session keeps its prompts and outputs in memory, subject to the
existing per-stream content cap. Copy and Copy All work on a large run **while it
is open**. Once archived as metadata only, the UI says so and disables Reuse and
the copy actions rather than loading empty strings that would look like the
original prompts.

## Out of scope

Not delivered here, by instruction: scoring or validators, A/B conclusions,
stance-divergence metrics, sequential or randomized execution, provider adapters
(OpenAI / OpenRouter / Anthropic / Google), calibration profiles, model-quality
judging, prompt-order optimization, and CI automation.

## Remaining risks

- **Memory, not disk, is now the binding constraint.** A 16 MiB session is held
  in memory for the life of the run, plus the request body. Concurrent sessions
  are one per Spark, so the ceiling is roughly `sparks × 16 MiB`.
- The 5-second heartbeat still applies: the browser tab must stay open. Unchanged
  by this work.
- `SHOWCASE_MAX_HISTORY_BODY_BYTES` × `SHOWCASE_HISTORY_LIMIT` bounds on-disk
  bodies per Spark (default 20 MiB). The index is bounded by metadata only.
- Raising `SHOWCASE_MAX_HISTORY_BODY_BYTES` to near the session limit would
  reintroduce large files — bounded per run now, but worth knowing before
  changing it.

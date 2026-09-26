# toolgate v1 — Pi orientation-gate pilot

An explicit `-e` extension, **not installed or enabled globally**. Tested against
Pi **0.87.1** and native open-codebase-index **0.26.0**. No npm dependencies.

## Run and roll back

```sh
# Deterministic, no model or network
 timeout 40 node --experimental-strip-types gate_tests/run.ts

# One live screening run (API authentication/embedding service required)
 timeout -k 10 300 bash bench/bench.sh G T4 local

# Existing results, no model calls
 timeout 30 python3 -B bench/report.py
```

For a normal dispatch, use the same explicit load order as `bench/bench.sh`:

1. `--no-extensions` disables ambient extension discovery.
2. `-e ~/.pi/agent/npm/node_modules/open-codebase-index/dist/pi-extension.js`
3. `-e /absolute/toolgate/bench/observer.ts` **only for benchmark inventory**.
4. `-e /absolute/toolgate/index.ts` **last**.

The benchmark invokes the existing **pi-complex** wrapper (gpt-6-astra:low),
leaves KB preflight intact, disables unrelated skill discovery, and explicitly
loads OCI's codebase-search skill. Both arms have identical tools and advisory
instructions; A sets `TOOLGATE_ARM=A` (logging only), G enforces. No Jev filter.
The approved set is OCI + observer + gate; version, order, and source hashes
are recorded in each new `bench/runs/*/run.json`. No other mutating extensions
are approved. `gate_tests/mutator.ts` proves why: before the gate its rewritten
command is blocked; after the gate it bypasses the earlier allow decision.
The latter is an explicitly **unapproved-order** test, not a supported sandbox.

Rollback: remove the gate's `-e` argument. Emergency bypass: create
`TOOLGATE_DISABLED` in `TOOLGATE_HARNESS_ROOT` (default this directory). Every
handler becomes inert, including logging; missing activation/outcome must not
be counted as enforced. Remove the file and restart to re-arm. If enabling a
file-disabled process without restart, it has no policy snapshot and fails
closed. No wrapper, settings.json, adapter, package, or daemon changes required.

## Dispatcher environment (startup snapshot)

| Variable | Default / meaning |
|---|---|
| `TOOLGATE_POLICY` | `policy.v1.json` beside extension |
| `TOOLGATE_HARNESS_ROOT` | extension directory; kill-switch location |
| `TOOLGATE_LOG` | harness-root `toolgate_log.jsonl` |
| `TOOLGATE_RUN_ID` | `manual`; privacy-safe dispatcher identifier |
| `TOOLGATE_DISPATCH_ID` | run ID; local sequence appended per new prompt |
| `TOOLGATE_ROOT` | optional expected canonical worktree root |
| `TOOLGATE_PATHS` | JSON array of dispatcher-approved paths, default `[]` |
| `TOOLGATE_KNOWN_SYMBOL` | optional exact symbol for graph substitution |
| `TOOLGATE_ARM` | `G`; `A` is advisory/logging only |
| `TOOLGATE_RUN_JSON` | observer-only existing metadata file |

Log directories must already exist and be writable. Keep policy, telemetry,
fixtures, and acceptance checks outside the agent's task worktree. A dispatcher
may select a policy copy; the model cannot grant itself exceptions by prose.
Policy is schema-validated, recursively frozen, and read once. Later file edits
or deletion are ignored and logged by metadata fingerprint, not reloaded.

## Enforcement

State is bound to `(dispatch_id, canonical worktree root, policy_version)`.
Every `before_agent_start` creates fresh state; compaction does not grant new
permission, and a resumed/forked process starts unoriented. No old result is
replayed as authorization.

* **NEEDS_ORIENTATION:** allow `index_status`, policy-listed context/lookup/
  graph tools, finite approved bash commands, and bounded reads of supplied
  paths. Other tools, edits, unbounded/multifile reads, and arbitrary shells
  are blocked. Default read reservation: 3 calls, 100 lines/call, 200 total.
* **ORIENTED:** requires a completed valid OCI `details` object associated with
  a pending call for this root. Context packs validate selected locations;
  known-symbol graphs validate resolution and edges. Ordinary text or a
  successful-looking tool-call event cannot grant orientation.
  `implementation_lookup` alone does not replace general orientation.
* **DEGRADED_AUTHORIZED:** only after observed unavailable/empty/unusable
  retrieval/status. Default fallback: 20 total raw operations, 200 lines/read,
  in-root edits/writes, and exactly `timeout 10 rg --files`. Other arbitrary
  bash remains denied. The degraded flag persists even after later recovery.

The default approved bash set is exactly `pwd` and
`timeout 10 git status --short`. Policy patterns are exact argv prefixes plus
finite suffix arrays; only plain-token, exact-string combinations are accepted.
No shell parsing, blacklist, substitution, command chaining, or auto-execution.

All calls in an assistant turn use its entry state, so even an early retrieval
result cannot unlock a sibling exploration call. Read budgets reserve
synchronously. Blocks are model-visible `code|exact next tool(example)` errors.
The fourth blocked call to the same tool exceeds default budget 3, latches
`gate_block_budget_exceeded`, emits a visible abort message, journals outcome,
and calls `ctx.abort()`. It does not rely on mixed-batch `terminate:true`.

Missing/inactive required tools are `gate_misconfigured`, never degraded.
Unexpected enforcement errors are `gate_unenforced`, never silent fail-open.
A broken external log falls back to the session journal and aborts. Fatal
internal/configuration failures require a fresh launch; budget/retrieval aborts
can start a new dispatch. `bounded-scratch` is logging only, selected for T3's
explicit full-ledger-read task.

## Evidence and interpretation

* `gate_tests/results.json`, `latest.txt`: direct extension-API tests; no model.
* `bench/schedule.txt`: counterbalanced A/G × T4/T5 × two repetitions, plus
  T3 A/G full-read exceptions. Fresh orphan worktrees; no commits/staging.
* `bench/tasks/`: unknown-entry-point discovery T4, known-symbol graph T5,
  and original T3. Immutable manifests, protected hashes, fixed tests, and
  separately expressed external acceptance oracles.
* `bench/runs/*/`: effective all/active inventory, source hashes, index setup,
  session JSONL, metadata, acceptance output, privacy-safe toolgate log.
* `bench/report.{json,txt}`: coverage includes setup failures; prevention and
  recovery are separate. Quality primary; 2x aggregate-token ratio is a
  secondary warning guardrail, not a token-savings requirement.

T4 intentionally asks for one raw-search probe in **both** arms to expose real
block/recovery. Its bypass rate is not an estimate of spontaneous model bypass.
Each eligible run cold-builds a real OCI index; status is checked first, watchers
and auto-index are disabled. Index setup time is reported; OCI does not return
embedding token billing, so no embedding cost is fabricated.

This pilot enforces ordering, not understanding, OS isolation, protection from
malicious extensions, or 99% deployment reliability. Arbitrary shell access
**after** orientation is deliberately outside this gate. Logs contain hashes
and metadata, not source/prompt contents; Pi session transcripts inherently
contain task contents and should be retained accordingly.

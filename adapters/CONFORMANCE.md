# toolgate — conformance test suite

A harness adapter is **conformant** when it passes every case below against its own
tool names and its own live policy. The suite is harness-agnostic: each case states
intent, and the adapter maps it to native tool names.

Run the reference implementations first: `gate_tests/run.ts` (Pi) and
`hermes/test_toolgate_hermes.py` + `hermes/prove_engine.py` (Hermes).

## A. Deterministic gate behaviour (no model, no network)

| # | Case | Expected |
|---|---|---|
| A1 | Raw recursive search before orientation | blocked; message names the retrieval tool |
| A2 | Whole-file read before orientation | blocked; message names the bounded read tool |
| A3 | In-place shell edit | blocked; message names the diff-reporting edit tool |
| A4 | Read-only allow-listed command | allowed |
| A5 | Non-governed tool (e.g. the retrieval tool itself) | allowed |
| A6 | Command containing shell metacharacters | **allowed** — out of claimed scope; a false block is worse than a miss |
| A7 | Valid retrieval **result** returned | state → `ORIENTED`; subsequent calls allowed |
| A8 | Retrieval **call** made but result empty/failed | state stays `NEEDS_ORIENTATION` (a call is not evidence) |
| A9 | Retrieval unavailable, fallback enabled | state → `DEGRADED_AUTHORIZED`; capped fallback allowed; logged |
| A10 | Retrieval unavailable, fallback disabled | honest abort with machine-readable reason |
| A11 | Repeated blocks past the budget | abort with `gate_block_budget_exceeded`; never loops forever |
| A12 | Kill switch file present | every handler inert; logs `kill_switch`; **no** block |
| A13 | Internal error in the gate | fail-open by default **and logged as unenforced**; fail-closed when requested |
| A14 | Missing / invalid policy | fail-open by default; fail-closed when requested; never a silent allow pretending to be enforcement |
| A15 | State not bound to this dispatch | result ignored; the previous dispatch's orientation does not unlock this one |

## B. Integration (through the real harness engine)

| # | Case | Expected |
|---|---|---|
| B1 | Block directive reaches the dispatcher | the tool call does not execute |
| B2 | Allow path | the tool call executes normally |
| B3 | Block message is actionable | the named replacement tool exists in the live tool list |
| B4 | Missing redirect target | loud configuration abort (not a block naming a nonexistent tool) |
| B5 | Consent / allowlist mechanics | hook is registered only after explicit consent |
| B6 | Fire latency | well under the configured timeout (measured: 8–46 ms) |

## C. Privacy

| # | Case | Expected |
|---|---|---|
| C1 | Decision log contents | decision codes, argv[0], hashes — **no** command bodies, no file paths, no file contents |
| C2 | Log location | outside the agent worktree |

## D. Coverage accounting

| # | Case | Expected |
|---|---|---|
| D1 | Kill-switch run | counted as **unenforced**, never as an enforced success |
| D2 | Setup failure | counted in the denominator |
| D3 | Prevention vs recovery | reported separately; recovery means the agent *complied after a block* |

## Reference results (2026-09-26)

- Pi adapter: 13/13 deterministic; 11 live runs; prevention 1.0; recovery 1.0; eligible bypass 0.
- Hermes adapter: 22/22 deterministic; 8/8 through the production hook engine.
- Neither establishes a 99% claim — that needs ~299 zero-failure representative dispatches.

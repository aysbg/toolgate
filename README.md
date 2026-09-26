# toolgate

**Deterministic tool-usage enforcement for AI coding agents.**

Agents reliably pick the wrong tool when the right one is only *advised*. Skills,
system prompts, and memory all describe preferred tools — none of them *force* the
use of one. Measured consequence: in an 18-run counterbalanced screen, an agent with
an index skill available still burned 53 raw reads across two context compactions and
failed its task, while quoting the skill that told it not to.

toolgate closes that gap with a small, deterministic gate in front of the agent's
tool calls. It is not a sandbox and not a security boundary against a hostile agent.
It is a discipline tool for cooperative agents: when a call would take a worse path,
the gate blocks it and names the exact better call to make instead.

## The measured problem

Two experiments, both with real dispatches on a real repo (Pi 0.87.1,
`gpt-6-astra:low`, counterbalanced A/G arms):

| Approach | Result |
|---|---|
| Advisory skill only | agent knew the right tool, used it anyway → task failure |
| Output **pre-filtering** (LLM or rules) | **−1.8% / −2.9%** run-level input tokens — an order of magnitude below the predeclared ≥15% gate |
| **Orientation gate** (this project) | prevention 1.0, recovery 1.0, eligible gate-bypasses **0** over 11 runs |

Pre-filtering fails because most tokens are not in *filterable* tool output — they are
in traversal strategy. Blocking a bad call before it runs attacks the cause; scrubbing
its output attacks a symptom.

## How it works

A three-state machine bound to a dispatch identity:

```
NEEDS_ORIENTATION --valid retrieval result--> ORIENTED
NEEDS_ORIENTATION --retrieval unavailable----> DEGRADED_AUTHORIZED (capped fallback)
any state --------unexpected gate failure----> ABORT (reported, never silent)
```

Rules that matter (each one learned from a failure):

- **Blocking is deterministic; compliance with guidance is probabilistic.** Both are
  measured separately (prevention *and* recovery) — never conflated.
- **`ORIENTED` requires a valid retrieval *result***, not merely a retrieval *call*.
- **Before orientation, arbitrary shell is denied**; a small allow-list of read-only
  commands is permitted. Blacklists lose to shell substitution and aliases.
- **Bound repeated blocks, then abort honestly.** No universal fail-open: a broken gate
  must not masquerade as a working one. Fail-open is a deliberate, logged choice.
- **Logs carry decision codes and hashes — never source content.**
- **Kill switch** that renders every handler inert, for rollback and for A-arm control.

## Layout

```
policy.v1.json        # the policy: profiles, allowed retrieval tools, budgets
policy_schema.ts      # hand-rolled schema validation (no deps)
index.ts, state.ts    # Pi extension adapter (tool_call veto)
gate_tests/           # 13 deterministic tests; no model, no network
bench/                # counterbalanced A/G harness, fixtures, independent oracles
hermes/               # Hermes pre_tool_call adapter (same design, Python)
```

## Harness support

| Harness | Enforcement primitive | Status |
|---|---|---|
| **Pi** (`pi-coding-agent`) | extension `tool_call` veto `{block, reason}` | implemented + benchmarked (13/13 deterministic tests, 11 live runs) |
| **Hermes** | blocking `pre_tool_call` shell hook | implemented + verified through the production hook engine (22 unit + 8 engine-level tests) |
| **Claude Code** | `PreToolUse` hook, `{"decision":"block","reason":...}` | port path designed; the dialect is shared |
| **Codex / OpenCode** | same Claude-Code hook dialect | port path designed |

The policy and the state machine are harness-agnostic. Adapters stay small: they
translate one policy file into native blocking primitives.

## Reliability, stated honestly

The gate is not claimed to work 99% of the time on the strength of a pilot. To claim
99% compliant handling with a binomial 95% lower bound you need **~299 zero-failure
representative dispatches**. The 11-run pilot establishes the *mechanism*; it does not
establish the *number*. Coverage denominators include setup failures and kill-switch
runs, so an unenforced run can never be counted as an enforced success.

## Quick start

```sh
# Deterministic tests: no model, no network
timeout 40 node --experimental-strip-types gate_tests/run.ts

# Hermes adapter
python3 -B hermes/test_toolgate_hermes.py     # 22 deterministic tests
```

See `README.md` in this directory and `hermes/README.md` for wiring, rollback, and the
kill switch.

## Non-goals

- Sandboxing a hostile agent that has arbitrary shell access.
- Output filtering (measured below the gate — see above).
- Prompt-based policy. The gate is deterministic code, with no LLM in the path.

## License

Apache-2.0.

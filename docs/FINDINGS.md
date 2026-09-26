# Measured findings

All numbers below come from real dispatches (Pi 0.87.1, `gpt-6-astra:low`,
counterbalanced A/G arms on synthetic fixtures with independent acceptance
oracles). Sample sizes are small — treat every number as evidence of
*mechanism*, not a precise estimate.

## Results table

| Arm | Config | Runs | Acceptance | Prevention | Recovery | Eligible bypass |
|---|---|---|---|---|---|---|
| A | advisory skill only | 4 (T4/T5 ×2) | 4/4 accepted | — | — | 5 (all in this arm) |
| G | gate active | 9 incl. smoke | 8/8 (+4 T4/T5 reps 3-4) | 1.0 | 0.92 | **0** over 13 eligible gate attempts |
| J | gate + Jev output filter | 4 (T4/T5 ×2) | 4/4 | 1.0 | 1.0 | 0 |

Recovery < 1.0 means: every blocked call was prevented (the call never
executed), and in one case the agent completed the task without retrying the
exact blocked operation — prevention and task completion are different
properties and are reported separately.

## Finding 1: output filtering is the wrong layer

An LLM output-filter arm (pre-registered ≥15% token-reduction gate) measured
**−1.8% / −2.9%** run-level input tokens — an order of magnitude below the
gate. Most tokens are not in filterable tool output; they are in traversal
strategy. Filtering attacks the symptom; blocking the bad call attacks the
cause.

## Finding 2: the gate subsumes the output filter

In the J arm (gate + filter), the filter **never fired**: across 6 gated
runs, 0 of 65 filter events had an eligible window — the gate's bounded
outputs (approved commands, capped reads, budgeted windows) never reached
the filter's 8 KB eligibility threshold. On gated dispatches, downstream
output filtering is redundant. A filter still has value on *ungated*
surfaces: other harnesses without a gate, compaction summaries, unbounded
read tools.

## Finding 3: what the gate costs — and where it pays

Per successful run (T4/T5 pooled, backfilled from session transcripts):

| Arm | Uncached input/run | Total tokens/run | Cost/run |
|---|---|---|---|
| A (advisory only) | 10,187 | 43,883 | $0.208 |
| G (gate) | 13,263 | 55,953 | $0.252 |
| J (gate + filter) | 9,931 | 47,226 | $0.218 |

The premium is **1.22–1.30× on successful runs** — the cost *is* the
mechanism (orientation queries the agent would otherwise skip).

But the economics of agent runs are dominated by **failure tails**, not
successful-run averages. The motivating failure (advisory-only arm) burned
**6.25M tokens / $12.94** — 30–250× a normal run — by raw-scanning into two
context compactions and failing its task. If uncontrolled traversal causes
even one tail event per ~100 runs, the tail alone outweighs the per-run
premium.

The long-run token reduction does **not** come from "calling the index
often" — large result dumps would increase tokens. It comes from the gate
forcing the agent to use the index as its memory instead of the context
window: fewer wasted reads, fewer compactions.

## Finding 4: overhead shrinks with a warm index

The first gated rounds (cold index per run) carried the full premium. Later
gated rounds trended to ~9.0K uncached / $0.21 per run — at or below the
advisory baseline. Budget for the premium on cold start; expect parity on
warm, well-indexed repos.

## Finding 5: tasks that need full reads need an exit

The `bounded-scratch` profile exists for tasks whose acceptance requires
complete documents (ledger audits, full-file reviews). Forcing semantic
orientation there is wrong: the profile deactivates the gate and the task
completes with zero blocks. Choose the profile at dispatch time.

## Reliability, stated honestly

Across 13 eligible gate attempts: coverage 1.0, prevention 1.0, recovery
0.92, eligible bypass 0, no acceptance regression. This establishes the
mechanism. A 99% reliability claim requires ~299 zero-failure representative
dispatches (binomial 95% lower bound) — we have not run them, and coverage
denominators include setup failures and kill-switch runs.
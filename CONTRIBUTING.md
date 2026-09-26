# Contributing

## The acceptance bar

A harness adapter is accepted when it passes **`adapters/CONFORMANCE.md`** against
its own tool names and its own live policy. That suite is the contract — a new
adapter is a translation of the same policy and the same state machine, not a new
implementation of the idea.

Run the reference tests before you start:

```sh
bash run_tests.sh          # Pi adapter + Hermes adapter, deterministic
```

## Rules that are not negotiable

These each exist because a failure proved them necessary. Do not "simplify" them
away in a PR:

- Blocking is deterministic; **compliance with guidance is probabilistic**. Measure
  both separately (prevention *and* recovery) and never report one as the other.
- `ORIENTED` requires a valid retrieval **result**, not merely a retrieval **call**.
- An unenforced run must never be logged as an enforced success.
- Fail-open is a deliberate, logged choice — never a silent default that makes a
  broken gate look like a working one.
- Logs carry decision codes and hashes. **Never** source content, command bodies,
  file paths, or file contents.
- A block message must name a replacement tool that actually exists in the target
  harness. A block naming a nonexistent tool is worse than no block.

## Adding an adapter

1. Read `adapters/PORTING.md`.
2. Copy the closest existing adapter.
3. Map tool names for your harness; resolve redirect targets from the harness's
   **live** tool list and abort loudly when one is missing.
4. Add deterministic tests. Ship them in the same PR — an untested adapter is not
   accepted.

## Claims discipline

The repository documents measured results. Do not upgrade "pilot" language to a
reliability percentage: a 99% claim requires roughly 299 zero-failure representative
dispatches, and we have not run them. If you add measurements, state the sample size
and the gate you predeclared.

## License

By contributing you agree your work is licensed under Apache-2.0.

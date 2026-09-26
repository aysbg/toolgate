#!/usr/bin/env bash
# toolgate — deterministic gate tests (Pi adapter + Hermes adapter).
# No model, no network. Exit 0 = all pass.
set -uo pipefail
cd "$(dirname "$0")"

fail=0

echo "== Pi adapter: deterministic gate tests =="
if timeout 60 node --experimental-strip-types gate_tests/run.ts; then
  echo "   Pi gate: PASS"
else
  echo "   Pi gate: FAIL"; fail=1
fi

echo
echo "== Hermes adapter: deterministic unit tests =="
if python3 -B hermes/test_toolgate_hermes.py; then
  echo "   Hermes unit: PASS"
else
  echo "   Hermes unit: FAIL"; fail=1
fi

echo
echo "== Hermes adapter: through the production hook engine =="
echo "   (requires a sandbox HERMES_HOME with the hook installed; see hermes/README.md)"
if [ -n "${TOOLGATE_HERMES_SANDBOX:-}" ]; then
  if python3 -B hermes/prove_engine.py "$TOOLGATE_HERMES_SANDBOX"; then
    echo "   Hermes engine: PASS"
  else
    echo "   Hermes engine: FAIL"; fail=1
  fi
else
  echo "   skipped (set TOOLGATE_HERMES_SANDBOX=/path/to/sandbox-hermes-home to run)"
fi

echo
if [ "$fail" -eq 0 ]; then echo "ALL GATE TESTS PASSED"; else echo "SOME TESTS FAILED"; fi
exit "$fail"

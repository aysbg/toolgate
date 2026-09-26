#!/usr/bin/env python3
"""Prove the toolgate Hermes hook blocks through the REAL Hermes hook engine.

Uses the production path: agent.shell_hooks.register_from_config() (what
hermes_cli.main calls at CLI startup) followed by the plugin manager's
invoke_hook('pre_tool_call', ...) — exactly what the agent loop calls before a
tool executes. Asserts a real block directive comes back.

Usage:  python3 -B prove_engine.py <sandbox_hermes_home>
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

SANDBOX = Path(sys.argv[1]).resolve()
os.environ["HERMES_HOME"] = str(SANDBOX)
os.environ["HERMES_ACCEPT_HOOKS"] = "1"  # sandbox consent only

sys.path.insert(0, str(Path.home() / ".hermes" / "hermes-agent"))

import yaml  # noqa: E402

from agent.shell_hooks import register_from_config  # noqa: E402
from hermes_cli.plugins import get_plugin_manager  # noqa: E402

cfg = yaml.safe_load((SANDBOX / "config.yaml").read_text())
specs = register_from_config(cfg)
print(f"registered specs: {len(specs)}")
for spec in specs:
    print(f"  event={spec.event} command={spec.command} fail_closed={spec.fail_closed}")

manager = get_plugin_manager()

CASES = [
    ("grep -r TODO backend/app", True, "HERMES_USE_SEARCH_FILES"),
    ("cat backend/app/main.py", True, "HERMES_USE_READ_FILE"),
    ("sed -i s/a/b/ x.py", True, "HERMES_USE_PATCH"),
    ("git status", False, None),
    ("pwd", False, None),
    ("rg --files", True, "HERMES_USE_SEARCH_FILES"),
    ("find . -name '*.py'", True, "HERMES_USE_SEARCH_FILES"),
    ("ls -la", False, None),
]

passed = failed = 0
for command, should_block, expected_code in CASES:
    raw = manager.invoke_hook(
        "pre_tool_call", tool_name="terminal", args={"command": command}, session_id="prove-session"
    )
    # The plugin manager returns the list of hook contributions; take the first block.
    results = raw if isinstance(raw, list) else [raw]
    block = next(
        (r for r in results if isinstance(r, dict) and r.get("action") == "block"), None
    )
    blocked = block is not None
    message = (block or {}).get("message", "")
    ok = blocked == should_block and (not should_block or expected_code in message)
    if ok:
        passed += 1
        verdict = f"BLOCK -> {message[:70]}" if blocked else "allow"
        print(f"  PASS  {command!r}: {verdict}")
    else:
        failed += 1
        print(f"  FAIL  {command!r}: expected should_block={should_block}, got raw={raw!r}")

print(f"\nengine-level: {passed} passed, {failed} failed")
sys.exit(1 if failed else 0)

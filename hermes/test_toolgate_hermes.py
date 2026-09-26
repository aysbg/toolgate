#!/usr/bin/env python3
"""Deterministic tests for the toolgate Hermes pre_tool_call adapter.

No model, no network. Run:  python3 -B test_toolgate_hermes.py
Exit code 0 = all pass.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ADAPTER = HERE / "toolgate_hermes.py"

passed = 0
failed = 0


def run_hook(payload: dict, env_extra: dict | None = None) -> tuple[int, dict | None, str]:
    """Run the adapter with a JSON payload on stdin; return (rc, parsed_stdout, stderr)."""
    env = dict(os.environ)
    env["TOOLGATE_POLICY"] = str(HERE / "policy.hermes.v1.json")
    env.setdefault("TOOLGATE_LOG", str(Path(tempfile.mkdtemp()) / "decisions.jsonl"))
    if env_extra:
        env.update(env_extra)
    proc = subprocess.run(
        [sys.executable, "-B", str(ADAPTER)],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        env=env,
        timeout=20,
    )
    out = None
    if proc.stdout.strip():
        try:
            out = json.loads(proc.stdout)
        except json.JSONDecodeError:
            out = None
    return proc.returncode, out, proc.stderr


def check(name: str, condition: bool, detail: str = "") -> None:
    global passed, failed
    if condition:
        passed += 1
        print(f"  PASS  {name}")
    else:
        failed += 1
        print(f"  FAIL  {name}  {detail}")


print("toolgate Hermes adapter — deterministic tests")

# 1. blocked: grep -r -> redirect to search_files
rc, out, _ = run_hook({"hook_event_name": "pre_tool_call", "tool_name": "terminal",
                       "tool_input": {"command": "grep -r TODO backend/app"}})
check("1 grep -r blocks", rc == 0 and out and out.get("action") == "block", str(out))
check("1b block names search_files", out and "search_files" in (out.get("message") or ""), str(out))
check("1c block carries a code", out and (out.get("message") or "").startswith("HERMES_USE_SEARCH_FILES|"), str(out))

# 2. blocked: cat -> read_file
rc, out, _ = run_hook({"tool_name": "terminal", "tool_input": {"command": "cat backend/app/main.py"}})
check("2 cat blocks", out and out.get("action") == "block", str(out))
check("2b block names read_file", out and "read_file" in (out.get("message") or ""), str(out))

# 3. blocked: sed -i -> patch
rc, out, _ = run_hook({"tool_name": "terminal", "tool_input": {"command": "sed -i 's/a/b/' file.py"}})
check("3 sed blocks", out and out.get("action") == "block", str(out))
check("3b block names patch", out and "patch" in (out.get("message") or ""), str(out))

# 4. allowed: read-only allow-list commands
for allowed in ["pwd", "git status", "git diff HEAD", "ls -la", "date"]:
    rc, out, _ = run_hook({"tool_name": "terminal", "tool_input": {"command": allowed}})
    check(f"4 allow-list: {allowed!r} not blocked", out is None, f"got {out}")

# 5. allowed: unrelated tool
rc, out, _ = run_hook({"tool_name": "search_files", "tool_input": {"pattern": "x"}})
check("5 non-terminal tool not blocked", out is None, str(out))

# 6. allowed: metacharacter command (adapter does not claim to govern it)
rc, out, _ = run_hook({"tool_name": "terminal",
                       "tool_input": {"command": "grep -r TODO . | head -5"}})
check("6 piped command not blocked (out of claim)", out is None, str(out))

# 7. kill switch
tmpdir = tempfile.mkdtemp()
kill = Path(tmpdir) / "TOOLGATE_DISABLED"
kill.write_text("")
rc, out, _ = run_hook({"tool_name": "terminal", "tool_input": {"command": "grep -r x ."}},
                      {"TOOLGATE_DISABLED_FILE": str(kill)})
check("7 kill switch disables enforcement", out is None, str(out))

# 8. malformed stdin -> fail open, exit 0
env = dict(os.environ)
env["TOOLGATE_POLICY"] = str(HERE / "policy.hermes.v1.json")
env["TOOLGATE_LOG"] = str(Path(tempfile.mkdtemp()) / "d.jsonl")
proc = subprocess.run([sys.executable, "-B", str(ADAPTER)], input="not json",
                      capture_output=True, text=True, env=env, timeout=20)
check("8 malformed input fails open", proc.returncode == 0 and not proc.stdout.strip(), proc.stdout)

# 9. missing policy -> fail open by default
rc, out, _ = run_hook({"tool_name": "terminal", "tool_input": {"command": "grep -r x ."}},
                      {"TOOLGATE_POLICY": "/nonexistent/policy.json"})
check("9 missing policy fails open by default", out is None, str(out))

# 10. missing policy + FAIL_CLOSED=1 -> blocks
rc, out, _ = run_hook({"tool_name": "terminal", "tool_input": {"command": "grep -r x ."}},
                      {"TOOLGATE_POLICY": "/nonexistent/policy.json", "TOOLGATE_FAIL_CLOSED": "1"})
check("10 missing policy fails closed when requested", out is not None and out.get("action") == "block", str(out))

# 11. content-free logging: no file paths or command bodies in the log
logdir = Path(tempfile.mkdtemp())
logfile = logdir / "decisions.jsonl"
run_hook({"tool_name": "terminal", "tool_input": {"command": "cat /etc/passwd"}},
         {"TOOLGATE_LOG": str(logfile)})
line = logfile.read_text().strip() if logfile.exists() else ""
check("11 decision log written", bool(line), "no log line")
check("11b log has no raw command text", "/etc/passwd" not in line, line)
check("11c log has decision code", "HERMES_USE_READ_FILE" in line, line)

# 12. empty command -> allow
rc, out, _ = run_hook({"tool_name": "terminal", "tool_input": {"command": ""}})
check("12 empty command allowed", out is None, str(out))

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)

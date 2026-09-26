#!/usr/bin/env python3
"""toolgate — Hermes pre_tool_call adapter.

Reads the Hermes JSON hook payload on stdin and emits a block directive when the
tool call should be redirected to a better tool.

Design notes (shared with the Pi extension; see ../README.md and KB 109/111):
  * Deterministic. No model, no network, no LLM.
  * Fail-OPEN on internal error by default: an enforcement bug must not wedge the
    agent. Set TOOLGATE_FAIL_CLOSED=1 to invert. A crash is reported on stderr and
    recorded as an unenforced event rather than silently masquerading as enforced.
  * Redirect-first: the block message names the exact replacement call, so the
    model can comply on the next turn (measured recovery, not just prevention).
  * Content-free logging: decision codes and argv[0] only. Never the full command,
    never file contents.

Wire it into ~/.hermes/config.yaml (see hermes/README.md).
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Policy loading — a local file, validated minimally, read per invocation.
# The hook is a short-lived subprocess, so per-invocation read is correct
# (no stale in-memory policy across a long-lived agent run).
# ---------------------------------------------------------------------------

_POLICY_PATH = Path(
    os.environ.get("TOOLGATE_POLICY", Path(__file__).resolve().parent / "policy.hermes.v1.json")
)
_LOG_PATH = Path(os.environ.get("TOOLGATE_LOG", Path.home() / ".hermes" / "toolgate_decisions.jsonl"))
_KILL_SWITCH = Path(
    os.environ.get("TOOLGATE_DISABLED_FILE", Path.home() / ".hermes" / "TOOLGATE_DISABLED")
)

# argv[0] values that mean "a raw scan/read/edit of the filesystem". A redirect
# entry fires only when argv[0] matches; the redirect is chosen by the entry.
_SHELL_METACHARS = re.compile(r"[;&|`$(){}<>\n]")


def _load_policy() -> dict:
    with open(_POLICY_PATH, encoding="utf-8") as handle:
        policy = json.load(handle)
    if not isinstance(policy, dict) or "redirects" not in policy:
        raise ValueError("policy missing 'redirects'")
    if not isinstance(policy["redirects"], dict) or not policy["redirects"]:
        raise ValueError("policy 'redirects' must be a non-empty mapping")
    return policy


def _log(record: dict) -> None:
    try:
        _LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with open(_LOG_PATH, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, sort_keys=True) + "\n")
    except Exception:  # logging must never break enforcement
        pass


def _argv0(command: str) -> str | None:
    """First token of a command, only when the command is a plain argv sequence.

    If the command contains shell metacharacters we cannot reason about it safely,
    so we return None and let the allow-list check decide.
    """
    if not isinstance(command, str) or not command.strip():
        return None
    if _SHELL_METACHARS.search(command):
        return None
    token = command.strip().split()[0]
    return os.path.basename(token)


def _command_prefix(command: str) -> str:
    """The first two tokens joined — used for the small allow-list of read-only commands."""
    parts = command.strip().split()
    return " ".join(parts[:2]) if len(parts) >= 2 else parts[0]


def _decision(tool_name: str, tool_input: dict, policy: dict) -> dict | None:
    """Return a block directive, or None to allow the call."""
    if tool_name != "terminal":
        return None  # this adapter only governs shell traversal

    command = (tool_input or {}).get("command")
    if not isinstance(command, str) or not command.strip():
        return None

    argv0 = _argv0(command)
    if argv0 is None:
        return None  # metacharacters present: not a case this adapter claims to govern

    # Read-only allow-list wins first (so `git status` etc. are never blocked).
    prefix = _command_prefix(command)
    if any(prefix == allowed or command.strip().startswith(allowed + " ") for allowed in policy.get("allow_list_commands", [])):
        _log({"event": "allow", "reason": "read_only_allowlist", "argv0": argv0})
        return None

    for name, entry in policy["redirects"].items():
        if argv0 in entry.get("argv0_any", []):
            return {
                "kind": name,
                "code": entry["code"],
                "redirect": entry["redirect"],
                "guidance": entry["guidance"],
                "argv0": argv0,
            }
    return None


def _emit_block(code: str, guidance: str) -> None:
    payload = {"action": "block", "message": f"{code}|{guidance}"}
    sys.stdout.write(json.dumps(payload))
    sys.stdout.flush()


def main() -> int:
    if _KILL_SWITCH.exists():
        _log({"event": "kill_switch"})
        return 0

    try:
        raw = sys.stdin.read()
        data = json.loads(raw) if raw.strip() else {}
    except Exception as exc:  # unparseable input: fail open, log
        _log({"event": "input_error", "error": type(exc).__name__})
        return 0

    try:
        policy = _load_policy()
    except Exception as exc:
        _log({"event": "policy_error", "error": type(exc).__name__})
        if os.environ.get("TOOLGATE_FAIL_CLOSED") == "1":
            _emit_block("HERMES_GATE_MISCONFIGURED", "toolgate policy could not be loaded; failing closed.")
        return 0

    tool_name = data.get("tool_name") or ""
    tool_input = data.get("tool_input") or {}
    if not isinstance(tool_input, dict):
        tool_input = {}

    try:
        decision = _decision(tool_name, tool_input, policy)
    except Exception as exc:
        _log({"event": "enforcement_error", "tool": tool_name, "error": type(exc).__name__})
        if os.environ.get("TOOLGATE_FAIL_CLOSED") == "1":
            _emit_block("HERMES_GATE_UNENFORCED", "toolgate enforcement error; failing closed.")
        return 0

    if decision is None:
        return 0

    _log(
        {
            "event": "block",
            "tool": tool_name,
            "kind": decision["kind"],
            "code": decision["code"],
            "argv0": decision.get("argv0"),
            "session_id": data.get("session_id") or "",
            "profile": data.get("profile") or "",
            "cwd": data.get("cwd") or "",
        }
    )
    _emit_block(decision["code"], decision["guidance"])
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except Exception:  # last-resort: never wedge the agent
        sys.stderr.write("toolgate: unexpected failure\n")
        raise SystemExit(0)

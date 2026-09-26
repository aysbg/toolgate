# toolgate — Claude Code / Codex / OpenCode adapter (port path)

These harnesses share one hook dialect: **Claude Code's `PreToolUse`**. Because they
converge on the same JSON wire format and the same exit-code convention, one adapter
serves all three — and the same script also runs under Hermes, which parses this
dialect natively.

## Why one adapter is enough

Verified in Hermes's own hook engine (`agent/shell_hooks.py`):

```
_PRE_TOOL_DIALECTS = (
    ("action",   "message", "reason", "args"),        # Hermes-canonical
    ("decision", "reason",  "message", "tool_input"), # Claude-Code-compatible
)
```

Hermes accepts both shapes. Claude Code, Codex and OpenCode emit the second. So the
policy file and the state machine are shared, and only the *entry point* differs per
harness — a path in a settings file rather than a different implementation.

## Wire contract

**stdin** (each harness's shape, normalised here):

```json
{
  "hook_event_name": "PreToolUse",
  "tool_name": "Bash",
  "tool_input": {"command": "grep -r TODO src"},
  "session_id": "...",
  "cwd": "/path/to/repo"
}
```

Claude Code nests the tool call under `tool_input`; Hermes uses the same key for its
`pre_tool_call` payload. Codex and OpenCode follow the Claude Code shape.

**stdout** — block:

```json
{"decision": "block", "reason": "HERMES_USE_SEARCH_FILES|Call search_files(...) instead"}
```

or, equivalently, `{"action": "block", "message": "..."}`.

**exit code 2 also blocks**, with stderr as the message — the simplest portable block
and the one supported by Claude Code, Cursor, Codex and Hermes alike.

## Porting recipe

1. Copy `hermes/toolgate_hermes.py` and `hermes/policy.hermes.v1.json`.
2. Rewrite the `tool_name` map per harness (table below) and the redirect targets to
   that harness's tool names.
3. Emit `{"decision": "block", "reason": ...}` (Claude Code dialect) instead of
   `{"action": "block", ...}` — or keep either; all three harnesses above accept
   `decision`, and Hermes accepts both.
4. Wire the path into the harness's hook/plugin settings.

## Tool-name map (per harness)

| Intent | Hermes | Claude Code | Codex | OpenCode |
|---|---|---|---|---|
| shell | `terminal` | `Bash` | `shell` | `bash` |
| read file | `read_file` | `Read` | `read` | `read` |
| search | `search_files` | `Grep`/`Glob` | `grep` | `grep` |
| edit | `patch` | `Edit` | `apply_patch` | `edit` |

The redirect targets also differ: Claude Code has a native `Grep` tool, so the gate
should redirect `grep -r` to `Grep`, not to a generic search. **Resolve the target tool
from the harness's live tool list at startup and refuse (abort loudly) when a required
redirect target is absent** — a block message that names a tool the harness does not
have is worse than no block.

## Not yet done

Only the Pi adapter and the Hermes adapter are implemented and tested. The Claude Code,
Codex and OpenCode entries above are a **designed port path backed by a shared dialect**,
not verified integrations. Do not describe them as working until an adapter for each has
been run against that harness.

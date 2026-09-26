# toolgate — Hermes adapter

Enforcement adapter that redirects raw-shell traversal to Hermes's own bounded
tools. Same design as the Pi extension in `../` (KB 109/111): deterministic,
fail-open on internal error, content-free logging, kill switch, and a block
message that names the exact replacement call.

## What it blocks

| Command family | Redirected to | Reason |
|---|---|---|
| `grep`, `rg`, `ag`, `ack`, `find`, `fd` | `search_files` | ripgrep-backed, bounded, no whole-file loads |
| `cat`, `head`, `tail`, `less`, `bat` | `read_file` | numbered lines, pagination, no full dumps |
| `sed`, `awk`, `perl` (in-place edits) | `patch` | diff-reporting, cannot silently corrupt |

Only `terminal` is governed, and only when the command is a plain argv sequence.
Commands with shell metacharacters (`|`, `;`, `$(...)`, redirects) are **not
blocked** — the adapter does not claim to reason about them, and a false block is
worse than a missed one.

Read-only commands on the allow-list (`pwd`, `date`, `git status`, `git diff`,
`git log`, `git rev-parse`, `ls`, `wc`, `which`, `hermes`) are never blocked.

## Install

```yaml
# ~/.hermes/config.yaml
hooks:
  pre_tool_call:
    - matcher: "terminal"
      command: "~/toolgate/hermes/toolgate_hermes.py"
      timeout: 10
      fail_closed: false
```

`fail_closed: false` is deliberate: an adapter bug must not wedge the agent. Use
`TOOLGATE_FAIL_CLOSED=1` only in a supervised harness where an unenforced run is
worse than a stopped one.

Consent: the first firing prompts once per `(event, command)` pair and records the
approval in `~/.hermes/shell-hooks-allowlist.json`. Check with `hermes hooks list`.

## Verify and roll back

```sh
python3 -B test_toolgate_hermes.py      # 22 deterministic tests, no model/network
hermes hooks list                      # matcher, timeout, consent status
hermes hooks test pre_tool_call        # fire against a synthetic payload
hermes hooks doctor                    # exec bit, allowlist, drift, JSON, timing
```

Roll back: remove the `hooks.pre_tool_call` entry from `config.yaml` (or
`hermes hooks revoke <command>`), then restart Hermes. Emergency bypass without
editing config: `touch ~/.hermes/TOOLGATE_DISABLED` — the adapter becomes inert
on the next invocation.

An unenforced run must never be counted as enforced: the kill switch logs
`{"event":"kill_switch"}` and emits no block.

## Log

`~/.hermes/toolgate_decisions.jsonl` — one line per decision: `event`, `tool`,
`kind`, `code`, `argv0`, `session_id`, `profile`, `cwd`. Never the command body,
never file contents.

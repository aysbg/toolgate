# Using toolgate

## What it does

A deterministic gate sits in front of the agent's tool calls. While the agent
has not yet produced a valid retrieval result, the gate blocks uncontrolled
traversal — raw recursive searches, whole-file reads, in-place shell edits —
and its block message names the exact call to make instead. Once orientation
evidence is valid, the gate steps aside.

## Pick a profile at dispatch time

| Profile | When to use | Behavior |
|---|---|---|
| `indexed-repo` | Any task on a repo with a usable index | Full orientation gate |
| `bounded-scratch` | Tasks whose acceptance requires complete documents (ledger audits, full-file reviews), or scratch work with no index | Gate inert; zero overhead |

Wrong profile = wrong tradeoff: `indexed-repo` on a full-read task produces
pointless blocks; `bounded-scratch` on a discovery task re-opens the
raw-scan failure mode.

## Pi (implemented + benchmarked)

```sh
# One dispatch, explicit load order (open-codebase-index first, gate LAST)
pi --no-extensions --no-skills \
  --tools bash,read,edit,write,index_status,index_codebase,codebase_context,codebase_edit_context,codebase_search,codebase_peek,implementation_lookup,call_graph,call_graph_path \
  -e ~/.pi/agent/npm/node_modules/open-codebase-index/dist/pi-extension.js \
  -e /absolute/path/to/toolgate/index.ts \
  -p "your task"
```

Rules:

- The gate must be the **last** `-e` — it reads earlier extensions' tool
  registrations and stays the final veto. Composition order is tested
  (`gate_tests/mutator.ts` proves a later mutating extension can invalidate
  an earlier allow decision).
- `--tools` is an **allowlist** in Pi: if it omits the retrieval tools, the
  gate aborts at startup (`gate_misconfigured`) instead of blocking calls
  toward tools that do not exist. If you see that abort, fix the tool list —
  do not remove the gate.
- Environment: `TOOLGATE_POLICY`, `TOOLGATE_ROOT`, `TOOLGATE_RUN_ID`,
  `TOOLGATE_DISPATCH_ID`, `TOOLGATE_ARM`, `TOOLGATE_LOG`,
  `TOOLGATE_HARNESS_ROOT`. See `index.ts` for the full contract.

Verify and roll back:

```sh
bash run_tests.sh                     # all deterministic tests
```

Rollback: remove the gate's `-e`. Emergency bypass: create `TOOLGATE_DISABLED`
in `TOOLGATE_HARNESS_ROOT` — every handler goes inert (logged as unenforced;
never counted as an enforced success).

## Hermes (implemented + engine-verified)

1. Copy `hermes/toolgate_hermes.py` and `hermes/policy.hermes.v1.json`
   somewhere stable (e.g. `~/toolgate/hermes/`).
2. Add to `~/.hermes/config.yaml`:

```yaml
hooks:
  pre_tool_call:
    - matcher: "terminal"
      command: "~/toolgate/hermes/toolgate_hermes.py"
      timeout: 10
      fail_closed: false
```

3. Approve the hook at the first-use prompt (or `hermes hooks list` to check
   consent status).
4. Verify: `hermes hooks doctor`.

`fail_closed: false` is deliberate (an adapter bug must not wedge the
agent). Invert with `TOOLGATE_FAIL_CLOSED=1` only in a supervised harness.
Emergency bypass: `touch ~/.hermes/TOOLGATE_DISABLED`.

What it blocks (argv[0] of a plain command only — metacharacter commands are
out of claimed scope and allowed):

| Command family | Redirected to |
|---|---|
| `grep` `rg` `ag` `ack` `find` `fd` | `search_files` |
| `cat` `head` `tail` `less` `more` `bat` | `read_file` |
| `sed` `awk` `perl` (in-place edits) | `patch` |

Read-only allow-list (`pwd`, `date`, `git status`, `git diff`, `git log`,
`git rev-parse`, `ls`, `wc`, `which`, `hermes`) is never blocked. Edit the
`redirects` / `allow_list_commands` blocks in `policy.hermes.v1.json` to fit
your harness.

## Claude Code / Codex / OpenCode

Same policy, same state machine, one hook script — see
`adapters/PORTING.md` for the dialect and tool-name map, and
`adapters/CONFORMANCE.md` for the suite a port must pass. These ports are
designed, not yet verified integrations.

## Operating discipline

- **Read the decision log**: `~/.hermes/toolgate_decisions.jsonl` (Hermes) or
  `TOOLGATE_LOG` (Pi). Decision codes, argv[0], hashes — never content.
- **Report prevention and recovery separately.** A gate that blocks but whose
  agent then fails the task is not a working gate.
- **Watch block rates.** A rising block rate on *valid* work means the policy
  is mistuned (or the wrong profile was chosen) — tune the policy, do not
  bypass the gate.
- **Unenforced is a state, not a success.** Kill-switch runs and setup
  failures stay in the coverage denominator.
- **Expect the premium on cold index, parity on warm.** See
  `docs/FINDINGS.md` for the measured economics.
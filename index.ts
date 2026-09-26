import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { freeze, validate } from './policy_schema.ts';
import { Gate, canonical } from './state.ts';

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
export default function toolgate(pi: ExtensionAPI) {
  const home = dirname(fileURLToPath(import.meta.url));
  const harness = resolve(process.env.TOOLGATE_HARNESS_ROOT || home);
  const policyPath = resolve(process.env.TOOLGATE_POLICY || `${home}/policy.v1.json`);
  const logPath = resolve(process.env.TOOLGATE_LOG || `${harness}/toolgate_log.jsonl`);
  const runId = process.env.TOOLGATE_RUN_ID || 'manual';
  const arm = process.env.TOOLGATE_ARM || 'G';
  const dispatchId = process.env.TOOLGATE_DISPATCH_ID || runId;
  const expectedRoot = process.env.TOOLGATE_ROOT;
  const knownSymbol = process.env.TOOLGATE_KNOWN_SYMBOL;
  let paths: string[] = [], policy: any, policyHash = '', stamp = '', configError = false;
  let gate: Gate | undefined, sequence = 0, notified = false, policyEditLogged = false;
  let fatalReason: string | null = null;
  const disabled = () => existsSync(`${harness}/TOOLGATE_DISABLED`);
  const fingerprint = () => {
    try { const s = statSync(policyPath); return `${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`; }
    catch (error: any) { if (error.code === 'ENOENT') return 'deleted'; throw error; }
  };
  // Immutable authority: no environment or policy reload after registration.
  if (!disabled()) {
    try {
      const raw = readFileSync(policyPath, 'utf8');
      policy = JSON.parse(raw); validate(policy); freeze(policy);
      policyHash = sha256(raw); stamp = fingerprint();
      paths = JSON.parse(process.env.TOOLGATE_PATHS || '[]');
      if (!Array.isArray(paths) || paths.some(p => typeof p !== 'string') || !['A', 'G'].includes(arm)) throw new Error('dispatch config');
    } catch { configError = true; }
  }
  const inert = () => arm === 'A' || policy?.profile === 'bounded-scratch';
  const record = (tool: string | null, code: string, before = gate?.state, meta: object = {}) => {
    appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), run_id: runId,
      dispatch_id: gate?.dispatch || dispatchId, root_sha256: gate ? sha256(gate.root) : null,
      policy_version: policy?.policy_version ?? null, policy_sha256: policyHash,
      tool, decision_code: code, state_transition: { from: before ?? null, to: gate?.state ?? null }, reason: code, ...meta }) + '\n', { mode: 0o600 });
  };
  const abort = (reason: string, ctx: any) => {
    fatalReason ??= reason;
    reason = fatalReason;
    gate?.abort(reason);
    if (!notified) {
      notified = true;
      const outcome = { ...(gate?.outcome() ?? {}), abort_reason: reason, enforced: false };
      // Journal and visible text survive a broken external telemetry sink.
      pi.appendEntry('toolgate_outcome', outcome);
      pi.sendMessage({ customType: 'toolgate_abort', content: `Toolgate dispatch aborted: ${reason}. No further tools will execute.`, display: true, details: outcome }, { triggerTurn: false });
    }
    ctx.abort();
  };
  const guard = (ctx: any, fn: () => any) => {
    if (disabled()) return;
    try { return fn(); }
    catch {
      // Logging-only arms do not acquire enforcement behavior on telemetry errors.
      if (inert()) { pi.appendEntry('toolgate_telemetry_error', { enforced: false }); return; }
      try { record(null, 'gate_unenforced'); }
      catch { /* External sink unavailable: abort() journals the failure in the session instead. */ }
      abort('gate_unenforced', ctx);
      return { block: true, reason: 'gate_unenforced|Dispatch aborted; report enforcement failure.' };
    }
  };
  const checkInventory = () => {
    const all = pi.getAllTools().map(t => t.name), active = pi.getActiveTools();
    return { all, active, valid: ['index_status', ...policy.allowed_retrieval_tools].every(t => all.includes(t) && active.includes(t)) };
  };
  pi.on('session_start', (_e, ctx) => guard(ctx, () => {
    if (configError) { record(null, 'gate_misconfigured'); abort('gate_misconfigured', ctx); return; }
    const inventory = checkInventory();
    record(null, 'startup', undefined, { inventory, profile: policy.profile, arm });
    if (!inert() && !inventory.valid) { configError = true; abort('gate_misconfigured', ctx); }
  }));
  pi.on('before_agent_start', (_e, ctx) => guard(ctx, () => {
    notified = false;
    if (fatalReason && fatalReason !== 'gate_block_budget_exceeded' && fatalReason !== 'gate_retrieval_unavailable') { abort(fatalReason, ctx); return; }
    fatalReason = null;
    if (configError) { abort('gate_misconfigured', ctx); return; }
    const root = canonical(ctx.cwd);
    gate = new Gate(policy, { root, dispatch: `${dispatchId}:${++sequence}`, paths, knownSymbol });
    if (expectedRoot && canonical(expectedRoot) !== root) { abort('gate_misconfigured', ctx); return; }
    record(null, inert() ? (arm === 'A' ? 'advisory_only' : 'bounded_scratch_full_read_exception') : 'dispatch_started');
    if (!inert() && !checkInventory().valid) abort('gate_misconfigured', ctx);
  }));
  pi.on('turn_start', (_e, ctx) => guard(ctx, () => { gate?.startTurn(); }));
  pi.on('tool_call', (e, ctx) => guard(ctx, () => {
    if (fatalReason) { abort(fatalReason, ctx); return { block: true, reason: `${fatalReason}|Dispatch aborted; report this failure.` }; }
    if (configError || !gate) { abort('gate_misconfigured', ctx); return { block: true, reason: 'gate_misconfigured|Dispatch aborted; repair launch configuration.' }; }
    if (!policyEditLogged && fingerprint() !== stamp) { policyEditLogged = true; record(null, 'policy_edit_ignored'); }
    if (inert()) {
      if (e.toolName === 'index_status' || policy.allowed_retrieval_tools.includes(e.toolName)) gate.call(e);
      record(e.toolName, 'allow_inert', undefined, { call_sha256: sha256(e.toolCallId), input_sha256: sha256(JSON.stringify(e.input)) }); return;
    }
    if (canonical(ctx.cwd) !== gate.root) gate.abort('gate_misconfigured');
    if (!checkInventory().valid) gate.abort('gate_misconfigured');
    const result = gate.call(e);
    record(e.toolName, result?.reason.split('|')[0] || 'allow', undefined, { call_sha256: sha256(e.toolCallId), input_sha256: sha256(JSON.stringify(e.input)), blocked: !!result?.block });
    if (gate.abortReason) abort(gate.abortReason, ctx);
    return result;
  }));
  pi.on('tool_result', (e, ctx) => guard(ctx, () => {
    if (!gate) return;
    const before = gate.state;
    if (canonical(ctx.cwd) !== gate.root) { abort('gate_misconfigured', ctx); return; }
    const code = gate.result(e);
    record(e.toolName, code, before, { call_sha256: sha256(e.toolCallId), result_sha256: sha256(JSON.stringify({ content: e.content, details: e.details })), is_error: e.isError });
    if (gate.abortReason && !inert()) abort(gate.abortReason, ctx);
  }));
  pi.on('agent_settled', (_e, ctx) => guard(ctx, () => {
    const outcome = { ...(gate?.outcome() ?? {}), abort_reason: fatalReason ?? gate?.abortReason ?? null, enforced: !!gate && !fatalReason && !gate.abortReason && !inert() && !configError, profile: policy?.profile, arm };
    record(null, 'outcome', undefined, outcome);
    pi.appendEntry('toolgate_outcome', outcome);
  }));
}

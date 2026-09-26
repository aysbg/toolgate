import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import toolgate from '../index.ts';
import mutator from './mutator.ts';
import { validate } from '../policy_schema.ts';

const base = JSON.parse(readFileSync(new URL('../policy.v1.json', import.meta.url), 'utf8'));
const tools = ['bash', 'read', 'edit', 'write', 'grep', 'index_status', ...base.allowed_retrieval_tools];
const temp = resolve('gate_tests/.tmp'); mkdirSync(temp, { recursive: true });
let id = 0, prevented = 0, unexpectedExecutions = 0;
const results: { test: string; passed: boolean }[] = [];
async function harness(options: any = {}) {
  const dir = mkdtempSync(`${temp}/run-`), root = `${dir}/worktree`;
  mkdirSync(root); writeFileSync(`${root}/known.ts`, 'export const known = 1;\n');
  const policy = structuredClone(base); Object.assign(policy, options.policy);
  writeFileSync(`${dir}/policy.json`, JSON.stringify(policy));
  if (options.kill) writeFileSync(`${dir}/TOOLGATE_DISABLED`, '');
  Object.assign(process.env, { TOOLGATE_POLICY: `${dir}/policy.json`, TOOLGATE_LOG: `${dir}/log.jsonl`, TOOLGATE_HARNESS_ROOT: dir,
    TOOLGATE_ROOT: root, TOOLGATE_RUN_ID: 'test', TOOLGATE_DISPATCH_ID: 'dispatch', TOOLGATE_PATHS: '["known.ts"]', TOOLGATE_ARM: options.arm || 'G' });
  delete process.env.TOOLGATE_KNOWN_SYMBOL;
  if (options.symbol) process.env.TOOLGATE_KNOWN_SYMBOL = options.symbol;
  const handlers = new Map<string, any[]>(), entries: any[] = [], messages: any[] = [], executed: any[] = [];
  const ctx = { cwd: root, aborts: 0, abort() { this.aborts++; } };
  let active = options.active || tools;
  const api: any = { on(name: string, fn: any) { handlers.set(name, [...(handlers.get(name) || []), fn]); },
    getAllTools: () => (options.tools || tools).map((name: string) => ({ name })), getActiveTools: () => active,
    appendEntry: (type: string, data: any) => entries.push({ type, data }), sendMessage: (m: any) => messages.push(m) };
  if (options.mutate === 'before') mutator(api);
  toolgate(api);
  if (options.mutate === 'after') mutator(api);
  async function emit(name: string, event: any = {}) {
    for (const fn of handlers.get(name) || []) {
      const result = await fn(event, ctx);
      if (name === 'tool_call' && result?.block) return result; // Pi runner's first-block-wins contract.
    }
  }
  await emit('session_start'); await emit('before_agent_start'); await emit('turn_start');
  async function call(toolName: string, input: any = {}, blocked?: boolean) {
    const e = { toolName, input, toolCallId: `call-${++id}` };
    const decision = await emit('tool_call', e);
    if (decision?.block) prevented++; else executed.push(structuredClone(e));
    if (blocked === true && !decision?.block) unexpectedExecutions++;
    if (blocked !== undefined) assert.equal(!!decision?.block, blocked, `${toolName} ${JSON.stringify(input)}`);
    return { e, decision };
  }
  async function result(call: any, details: any, text = 'retrieved evidence', isError = false) {
    await emit('tool_result', { ...call.e, details, content: [{ type: 'text', text }], isError });
  }
  const valid = () => ({ route: 'conceptual', tokenBudget: 600, tokenEstimate: 80, selectedCount: 1, results: [{ filePath: 'known.ts', startLine: 1, endLine: 1 }] });
  const log = () => { try { return readFileSync(`${dir}/log.jsonl`, 'utf8').trim().split('\n').map(JSON.parse); } catch (e: any) { if (e.code === 'ENOENT') return []; throw e; } };
  const outcome = async () => { await emit('agent_settled'); return entries.at(-1)?.data; };
  return { dir, root, emit, call, result, valid, log, outcome, ctx, entries, messages, executed, active: (v: string[]) => { active = v; } };
}
async function test(name: string, fn: () => Promise<void>) {
  await fn(); results.push({ test: name, passed: true }); console.log(`PASS ${name}`);
}
await test('1 block bash grep/rg/cat, arbitrary shells, broad reads and edits', async () => {
  for (const command of ['grep x .', 'rg x .', 'cat known.ts', 'python3 -c pass', 'pwd; rg x', 'pwd $(cat x)', 'alias p=rg; p x', 'env bash -c pwd', 'pwd\ncat known.ts', 'pwd > out']) {
    const h = await harness(); const c = await h.call('bash', { command }, true);
    assert.match(c.decision.reason, /^gate_needs_orientation\|Call index_status\(\{\}\)/);
  }
  const h = await harness();
  for (const path of ['*', ['known.ts', 'other.ts'], 'known.ts']) await h.call('read', { path }, true);
  await h.call('edit', { path: 'known.ts', oldText: '1', newText: '2' }, true);
  await h.call('write', { path: 'new.ts', content: 'x' }, true);
  await h.call('custom_exec', { code: 'anything' }, true);
});
await test('2 allow approved commands, bounded dispatcher reads and retrieval tools', async () => {
  const h = await harness();
  for (const command of ['pwd', 'timeout 10 git status --short']) await h.call('bash', { command }, false);
  await h.call('read', { path: 'known.ts', limit: 100, offset: null }, false);
  await h.call('read', { path: 'known.ts', limit: 100, offset: 2 }, false);
  await h.call('read', { path: 'known.ts', limit: 1 }, true);
  for (const tool of ['index_status', ...base.allowed_retrieval_tools]) await h.call(tool, { query: 'known', name: 'known' }, false);
});
await test('3 completed structural context, not a call or invalid/text success, unlocks', async () => {
  const h = await harness(), c = await h.call('codebase_context', { query: 'known' }, false);
  await h.call('grep', { pattern: 'x' }, true);
  await h.result(c, h.valid()); await h.emit('turn_start');
  await h.call('grep', { pattern: 'x' }, false);
  assert.equal((await h.outcome()).state, 'ORIENTED');
  for (const d of [undefined, {}, { route: 'conceptual', selectedCount: 1 }, { ...h.valid(), results: [{ filePath: '/etc/passwd', startLine: 1, endLine: 1 }] }]) {
    const bad = await harness(), req = await bad.call('codebase_context', {});
    await bad.result(req, d, 'plain text says success'); await bad.emit('turn_start');
    await bad.call('bash', { command: 'rg x .' }, true);
    assert.notEqual((await bad.outcome()).state, 'ORIENTED');
  }
  const fail = await harness(), req = await fail.call('codebase_context');
  await fail.result(req, undefined, 'index unavailable');
  assert.equal((await fail.outcome()).state, 'DEGRADED_AUTHORIZED');
});
await test('4 same-message context plus grep cannot self-satisfy even if result wins race', async () => {
  const h = await harness();
  const [c] = await Promise.all([h.call('codebase_context', { query: 'known' }, false), h.call('grep', { pattern: 'x' }, true)]);
  await h.result(c, h.valid());
  await h.call('grep', { pattern: 'x' }, true); // still the original assistant turn
  await h.emit('turn_start'); await h.call('grep', { pattern: 'x' }, false);
});
await test('5 fourth repeated block aborts entire mixed batch with visible final text', async () => {
  const h = await harness(); await h.call('index_status', {}, false);
  for (let i = 0; i < 4; i++) await h.call('bash', { command: 'rg x .' }, true);
  assert.equal((await h.outcome()).abort_reason, 'gate_block_budget_exceeded');
  assert.match(h.messages.at(-1).content, /gate_block_budget_exceeded/);
  assert.ok(h.ctx.aborts > 0); await h.call('index_status', {}, true);
});
await test('6 availability, persistent degraded flag and bounded fallback', async () => {
  const h = await harness({ policy: { degraded_fallback: { ...base.degraded_fallback, calls: 2 } } });
  const c = await h.call('index_status'); await h.result(c, { indexed: false, vectorCount: 0, indexPath: `${h.root}/index` });
  await h.emit('turn_start');
  await h.call('bash', { command: 'timeout 10 rg --files' }, false);
  await h.call('read', { path: 'known.ts', limit: 10 }, false);
  await h.call('read', { path: 'known.ts', limit: 10 }, true);
  const retrieval = await h.call('codebase_context'); await h.result(retrieval, h.valid());
  const o = await h.outcome(); assert.equal(o.state, 'ORIENTED'); assert.equal(o.degraded, true);
  const empty = await harness(), q = await empty.call('codebase_context');
  await empty.result(q, { route: 'conceptual', selectedCount: 0 });
  assert.equal((await empty.outcome()).degraded, true);
  const noFallback = await harness({ policy: { degraded_fallback: { ...base.degraded_fallback, enabled: false } } });
  await noFallback.result(await noFallback.call('index_status'), { indexed: false });
  assert.equal((await noFallback.outcome()).abort_reason, 'gate_retrieval_unavailable');
});
await test('6b internal telemetry failure aborts gate_unenforced; missing/inactive tools are config failures', async () => {
  const h = await harness(); rmSync(`${h.dir}/log.jsonl`); mkdirSync(`${h.dir}/log.jsonl`);
  const c = await h.call('bash', { command: 'pwd' }, true);
  assert.match(c.decision.reason, /^gate_unenforced\|/);
  assert.equal(h.entries.at(-1).data.abort_reason, 'gate_unenforced');
  for (const opts of [{ tools: tools.filter(t => t !== 'codebase_context') }, { active: ['bash'] }, { policy: { block_budget: 0 } }]) {
    const broken = await harness(opts); await broken.call('bash', { command: 'pwd' }, true);
    assert.equal(broken.entries.at(-1).data.abort_reason, 'gate_misconfigured');
  }
  const inactive = await harness(); inactive.active(['bash']); await inactive.call('bash', { command: 'pwd' }, true);
});
await test('7 dispatch/root binding, late results, compaction, reused sessions', async () => {
  const h = await harness(), c = await h.call('codebase_context');
  await h.result(c, h.valid()); await h.emit('turn_start'); await h.call('grep', {}, false);
  await h.emit('session_compact'); await h.call('grep', {}, false);
  const first = await h.outcome(); await h.emit('before_agent_start'); await h.emit('turn_start');
  await h.result(c, h.valid()); await h.call('grep', {}, true);
  const second = await h.outcome(); assert.notEqual(first.dispatch_id, second.dispatch_id); assert.equal(second.state, 'NEEDS_ORIENTATION');
  h.ctx.cwd = h.dir; await h.call('bash', { command: 'pwd' }, true);
  assert.equal((await h.outcome()).abort_reason, 'gate_misconfigured');
});
await test('8 kill switch fully inert and bounded-scratch logs explicit full-read exception', async () => {
  const h = await harness({ kill: true, tools: [] });
  await h.call('bash', { command: 'rg x .' }, false); await h.call('edit', { path: 'x' }, false);
  assert.equal(h.log().length, 0); assert.equal(h.ctx.aborts, 0);
  const scratch = await harness({ policy: { profile: 'bounded-scratch' }, tools: [] });
  await scratch.call('read', { path: '*' }, false);
  assert.ok(scratch.log().some(e => e.decision_code === 'bounded_scratch_full_read_exception'));
  assert.equal((await scratch.outcome()).enforced, false);
  const dynamic = await harness(); writeFileSync(`${dynamic.dir}/TOOLGATE_DISABLED`, ''); await dynamic.call('bash', { command: 'rg x .' }, false);
});
await test('9 input mutator before gate blocked; after gate is explicitly unapproved order', async () => {
  const before = await harness({ mutate: 'before' }); await before.call('bash', { command: 'pwd' }, true); assert.equal(before.executed.length, 0);
  const after = await harness({ mutate: 'after' }); await after.call('bash', { command: 'pwd' }, false);
  assert.equal(after.executed[0].input.command, 'rg secret .'); // known composition limit, not approved execution
});
await test('10 immutable policy snapshot, symlink/read budgets, privacy and schema validation', async () => {
  const h = await harness();
  writeFileSync(`${h.dir}/policy.json`, JSON.stringify({ ...base, profile: 'bounded-scratch' }));
  await h.call('bash', { command: 'rg PRIVATE_PROMPT .' }, true);
  assert.ok(h.log().some(e => e.decision_code === 'policy_edit_ignored'));
  assert.ok(!JSON.stringify(h.log()).includes('PRIVATE_PROMPT'));
  symlinkSync('/etc/passwd', `${h.root}/escape`); await h.call('read', { path: 'escape', limit: 1 }, true);
  for (const v of [{ ...base, extra: 1 }, { ...base, toString: 'unexpected' }, { ...base, allowed_retrieval_tools: [] }, { ...base, block_budget: '3' }]) assert.throws(() => validate(v));
  await Promise.all([h.call('read', { path: 'known.ts', limit: 100 }, false), h.call('read', { path: 'known.ts', limit: 100 }, false)]);
  await h.call('read', { path: 'known.ts', limit: 1 }, true);
});
await test('11 known-symbol graph substitute only with resolved, structurally valid evidence', async () => {
  const details = { direction: 'callers', resolution: { status: 'resolved', symbolId: 's', name: 'known', filePath: 'known.ts', startLine: 1 }, callers: [], callees: [] };
  for (const symbol of [undefined, 'known']) {
    const h = await harness({ symbol }), c = await h.call('call_graph', { name: 'known' }); await h.result(c, details); await h.emit('turn_start');
    await h.call('grep', {}, !symbol); assert.equal((await h.outcome()).state, symbol ? 'ORIENTED' : 'NEEDS_ORIENTATION');
  }
  const h = await harness({ symbol: 'known' }), c = await h.call('call_graph', { name: 'known' });
  await h.result(c, { ...details, callers: [{}] }); assert.equal((await h.outcome()).state, 'NEEDS_ORIENTATION');
});
await test('12 guidance respects a restricted retrieval allowlist', async () => {
  const h = await harness({ symbol: 'known', policy: { allowed_retrieval_tools: ['codebase_context'] } });
  await h.result(await h.call('index_status'), { indexed: true, vectorCount: 1, indexPath: `${h.root}/index` });
  const c = await h.call('bash', { command: 'rg x .' }, true);
  assert.match(c.decision.reason, /Call codebase_context/);
});
assert.equal(unexpectedExecutions, 0);
const report = { passed: results.length, failed: 0, prevented, unauthorized_executions_approved_order: unexpectedExecutions, unapproved_order_bypass_demonstrated: true, tests: results };
writeFileSync('gate_tests/results.json', JSON.stringify(report, null, 2) + '\n');
rmSync(temp, { recursive: true, force: true });
console.log(JSON.stringify(report, null, 2));

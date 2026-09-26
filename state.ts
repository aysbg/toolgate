import { realpathSync, existsSync } from 'node:fs';
import { resolve, relative, dirname, isAbsolute } from 'node:path';

export const NEEDS = 'NEEDS_ORIENTATION';
export const ORIENTED = 'ORIENTED';
export const DEGRADED = 'DEGRADED_AUTHORIZED';
export function canonical(path: string): string { return realpathSync(path); }
export function localPath(root: string, path: unknown): string | undefined {
  if (typeof path !== 'string' || !path || /[\0*?\n]/.test(path)) return;
  const full = resolve(root, path);
  // Resolve symlinks, including the parent of a not-yet-created edit target.
  let actual: string;
  try { actual = existsSync(full) ? canonical(full) : resolve(canonical(dirname(full)), full.slice(dirname(full).length + 1)); }
  catch (error: any) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return; throw error; }
  const rel = relative(root, actual);
  if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) return;
  return actual;
}
export function approvedCommand(command: unknown, patterns: any[]): boolean {
  // No shell parser: the language is exactly a finite set of plain argv sequences.
  // This rejects substitutions, quoting, redirections, chaining, aliases and wrappers.
  if (typeof command !== 'string' || !/^[A-Za-z0-9_./ -]+$/.test(command)) return false;
  return patterns.some(p => p.args.some((args: string[]) => [...p.prefix, ...args].join(' ') === command));
}
const positive = (n: any) => Number.isSafeInteger(n) && n > 0;
const textOf = (e: any) => (e.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');

export class Gate {
  policy: any;
  root: string;
  dispatch: string;
  knownSymbol?: string;
  paths: Set<string>;
  state = NEEDS;
  turnState = NEEDS;
  degraded = false;
  abortReason: string | null = null;
  blocks = new Map<string, number>();
  pending = new Map<string, { tool: string; input: any; dispatch: string; root: string }>();
  reads = 0;
  lines = 0;
  fallbackCalls = 0;
  statusSeen = false;
  constructor(policy: any, binding: { root: string; dispatch: string; paths: string[]; knownSymbol?: string }) {
    this.policy = policy;
    this.root = canonical(binding.root);
    this.dispatch = binding.dispatch;
    this.knownSymbol = binding.knownSymbol;
    this.paths = new Set(binding.paths.map(p => localPath(this.root, p)).filter((p): p is string => !!p));
  }
  startTurn() { this.turnState = this.state; }
  abort(reason: string) { this.abortReason ??= reason; }
  guidance(): string {
    if (!this.statusSeen) return 'Call index_status({})';
    if (this.knownSymbol && this.policy.allowed_retrieval_tools.includes('call_graph')) return `Call call_graph(${JSON.stringify({ name: this.knownSymbol })})`;
    return 'Call codebase_context({"query":"locate task entry points","tokenBudget":600,"limit":5})';
  }
  block(tool: string, code: string) {
    const count = (this.blocks.get(tool) ?? 0) + 1;
    this.blocks.set(tool, count);
    if (count > this.policy.block_budget) { this.abort('gate_block_budget_exceeded'); code = this.abortReason!; }
    return { block: true as const, reason: `${code}|${this.abortReason ? 'Dispatch aborted; stop tool use and report this reason.' : this.guidance()}` };
  }
  call(e: any) {
    if (this.abortReason) return { block: true as const, reason: `${this.abortReason}|Dispatch aborted; stop tool use and report this reason.` };
    const tool = e.toolName, input = e.input;
    if (tool === 'index_status' || this.policy.allowed_retrieval_tools.includes(tool)) {
      this.pending.set(e.toolCallId, { tool, input: structuredClone(input), dispatch: this.dispatch, root: this.root });
      return;
    }
    if (this.turnState === ORIENTED) return;
    if (tool === 'bash' && approvedCommand(input.command, this.policy.approved_bash)) return;
    if (this.turnState === DEGRADED) {
      if (this.fallbackCalls >= this.policy.degraded_fallback.calls) return this.block(tool, 'gate_fallback_budget');
      let allowed = tool === 'bash' && approvedCommand(input.command, this.policy.degraded_fallback.approved_bash);
      if (tool === 'read') allowed = !!localPath(this.root, input.path) && positive(input.limit) && input.limit <= this.policy.degraded_fallback.read_lines && (input.offset == null || positive(input.offset));
      if (['edit', 'write'].includes(tool)) allowed = this.policy.degraded_fallback.allow_edits && !!localPath(this.root, input.path);
      if (allowed) { this.fallbackCalls++; return; }
      return this.block(tool, 'gate_fallback_denied');
    }
    if (tool === 'read') {
      const path = localPath(this.root, input.path);
      const budget = this.policy.read_budget;
      if (path && this.paths.has(path) && positive(input.limit) && input.limit <= budget.lines && (input.offset == null || positive(input.offset)) && this.reads < budget.calls && this.lines + input.limit <= budget.total_lines) {
        // Reserve synchronously, before any parallel read can consume the same budget.
        this.reads++; this.lines += input.limit; return;
      }
      return this.block(tool, 'gate_read_denied');
    }
    return this.block(tool, 'gate_needs_orientation');
  }
  result(e: any): string {
    const pending = this.pending.get(e.toolCallId);
    this.pending.delete(e.toolCallId);
    if (!pending || pending.tool !== e.toolName || pending.dispatch !== this.dispatch || pending.root !== this.root || this.abortReason) return 'result_ignored';
    const d = e.details, tool = e.toolName;
    const location = (r: any) => r && !!localPath(this.root, r.filePath) && positive(r.startLine) && positive(r.endLine) && r.endLine >= r.startLine;
    const resolution = (r: any) => r?.status === 'resolved' && typeof r.symbolId === 'string' && typeof r.name === 'string' && !!localPath(this.root, r.filePath);
    let valid = false, failure = false;
    if (tool === 'index_status') {
      this.statusSeen = true;
      // An index directory is not evidence: only the provider's structured status is.
      valid = d?.indexed === true && positive(d.vectorCount) && !!localPath(this.root, d.indexPath) && d.compatibility?.compatible !== false;
      failure = !valid;
    } else if (tool === 'codebase_context') {
      if (d && ['conceptual', 'definition'].includes(d.route)) {
        valid = positive(d.selectedCount) && Array.isArray(d.results) && d.results.length === d.selectedCount && d.results.every(location) && positive(d.tokenBudget) && Number.isFinite(d.tokenEstimate) && d.tokenEstimate > 0;
        failure = d.selectedCount === 0 || d.recovery?.successfulAttempt === null || (!d.results && /No matching code|No definition found/.test(textOf(e)));
      } else if (d && ['path', 'direct-edge'].includes(d.route)) {
        valid = positive(d.resultCount) && positive(d.tokenBudget) && Number.isFinite(d.tokenEstimate) && d.tokenEstimate > 0 && !!pending.input.from && !!pending.input.to;
        failure = d.resultCount === 0;
      }
    } else if (tool === 'call_graph') {
      valid = !!this.knownSymbol && pending.input.name === this.knownSymbol && resolution(d?.resolution) && d.resolution.name === this.knownSymbol && ['callers', 'callees'].includes(d.direction) && Array.isArray(d.callers) && Array.isArray(d.callees) && [...d.callers, ...d.callees].every((edge: any) => typeof edge.fromSymbolId === 'string' && (typeof edge.toSymbolId === 'string' || typeof edge.targetName === 'string') && positive(edge.line));
      failure = d?.resolution?.status === 'not_found';
    } else if (tool === 'call_graph_path') {
      valid = !!this.knownSymbol && [pending.input.from, pending.input.to].includes(this.knownSymbol) && resolution(d?.from) && resolution(d?.to) && Array.isArray(d.path) && d.path.length > 0 && d.path.every((n: any) => typeof n.symbolId === 'string' && !!localPath(this.root, n.filePath));
      failure = Array.isArray(d?.path) && d.path.length === 0;
    } else if (tool === 'implementation_lookup') {
      // Approved retrieval, but general orientation still requires context; known-symbol graph is the substitute.
      failure = Array.isArray(d) && d.length === 0;
    }
    if (tool !== 'index_status' && valid && !e.isError) {
      this.state = ORIENTED;
      return 'retrieval_valid';
    }
    const expectedError = /INDEX_BUSY|index.*(?:unavailable|not (?:found|initialized)|missing)|No matching code|No definition found|ECONNREFUSED|ETIMEDOUT|fetch failed|embedding.*(?:failed|unavailable)/i.test(textOf(e));
    if ((failure || expectedError) && this.state !== ORIENTED) {
      if (this.policy.degraded_fallback.enabled) { this.state = DEGRADED; this.degraded = true; return 'retrieval_unavailable'; }
      this.abort('gate_retrieval_unavailable');
    }
    return valid ? 'status_ready' : 'retrieval_invalid';
  }
  outcome() {
    return { dispatch_id: this.dispatch, policy_version: this.policy.policy_version, state: this.state, degraded: this.degraded, abort_reason: this.abortReason, enforced: !this.abortReason, blocks: Object.fromEntries(this.blocks), fallback_calls: this.fallbackCalls };
  }
}

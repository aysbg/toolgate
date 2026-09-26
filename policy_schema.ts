// Embedded JSON Schema; deliberately only the keywords used by this policy.
const integer = { type: 'integer', minimum: 1, maximum: 10000 };
const string = { type: 'string', minLength: 1 };
const object = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const commands = { type: 'array', maxItems: 32, items: object({ prefix: { type: 'array', minItems: 1, items: string }, args: { type: 'array', items: { type: 'array', items: string } } }) };
export const schema = object({
  policy_version: { const: '1' },
  profile: { enum: ['indexed-repo', 'bounded-scratch'] },
  allowed_retrieval_tools: { type: 'array', minItems: 1, uniqueItems: true, items: { enum: ['codebase_context', 'call_graph', 'call_graph_path', 'implementation_lookup'] } },
  approved_bash: commands,
  read_budget: object({ calls: integer, lines: integer, total_lines: integer }),
  block_budget: integer,
  degraded_fallback: object({ enabled: { type: 'boolean' }, calls: integer, read_lines: integer, approved_bash: commands, allow_edits: { type: 'boolean' } }),
});
export function validate(value: any, rule: any = schema, path = 'policy'): void {
  const fail = () => { throw new Error(`Invalid ${path}`); };
  if (rule.const !== undefined && value !== rule.const) fail();
  if (rule.enum && !rule.enum.includes(value)) fail();
  if (rule.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
    if (Object.keys(value).some(k => !Object.hasOwn(rule.properties, k))) fail();
    for (const k of rule.required) { if (!Object.hasOwn(value, k)) fail(); validate(value[k], rule.properties[k], `${path}.${k}`); }
  }
  if (rule.type === 'array') {
    if (!Array.isArray(value) || value.length < (rule.minItems ?? 0) || value.length > (rule.maxItems ?? Infinity)) fail();
    if (rule.uniqueItems && new Set(value).size !== value.length) fail();
    value.forEach((item: any, i: number) => validate(item, rule.items, `${path}[${i}]`));
  }
  if (rule.type === 'string' && (typeof value !== 'string' || value.length < (rule.minLength ?? 0))) fail();
  if (rule.type === 'integer' && (!Number.isSafeInteger(value) || value < rule.minimum || value > rule.maximum)) fail();
  if (rule.type === 'boolean' && typeof value !== 'boolean') fail();
  if (path === 'policy' && !value.allowed_retrieval_tools.includes('codebase_context')) fail();
}
export function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

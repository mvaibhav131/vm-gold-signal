import { strategyConfigSchema, type StrategyConfig } from '@vmgs/config';

/** `gates.quality.min=70` to the path and the value; the value is JSON when it parses as JSON (a number, true, a list) and text otherwise. */
export function parseAssignment(text: string): { path: string[]; value: unknown } {
  const at = text.indexOf('=');
  if (at <= 0) throw new Error(`"${text}" is not path=value`);
  const path = text.slice(0, at).split('.');
  if (path.some((part) => part === '' || part === '__proto__' || part === 'constructor')) {
    throw new Error(`"${text.slice(0, at)}" is not a path`);
  }
  const raw = text.slice(at + 1);
  try {
    return { path, value: JSON.parse(raw) as unknown };
  } catch {
    return { path, value: bareList(raw) ?? raw };
  }
}

/** `[TREND_UP,TREND_DOWN]` or `[1, 2.5]` without quotes (a shell takes the quotes of JSON away): a list of numbers and words. */
function bareList(raw: string): unknown[] | null {
  const found = /^\[(.*)\]$/.exec(raw.trim());
  if (found === null) return null;
  const inside = found[1] ?? '';
  if (inside.trim() === '') return [];
  return inside.split(',').map((part) => {
    const item = part.trim();
    return item !== '' && Number.isFinite(Number(item)) ? Number(item) : item;
  });
}

function setAt(target: Record<string, unknown>, path: readonly string[], value: unknown): void {
  let node = target;
  for (const part of path.slice(0, -1)) {
    const next = node[part];
    if (typeof next !== 'object' || next === null || Array.isArray(next)) {
      throw new Error(`there is no "${part}" in the config on the way to ${path.join('.')}`);
    }
    node = next as Record<string, unknown>;
  }
  const last = path.at(-1) ?? '';
  if (!(last in node)) throw new Error(`the config has no "${path.join('.')}"`);
  node[last] = value;
}

/**
 * A variant of a strategy config: a copy with the given values changed (only names that exist can be set), checked
 * by the config schema, and with a version of its own: the patch number is 1000 plus the number of the trial, so a variant (for
 * example 0.1.1001) is never taken for a version that was made on purpose, and never deployed.
 */
export function variantOf(
  config: StrategyConfig,
  assignments: readonly string[],
  trial: number,
): StrategyConfig {
  if (assignments.length === 0) throw new Error('a variant needs at least one --set path=value');
  const copy = structuredClone(config) as unknown as Record<string, unknown>;
  for (const text of assignments) {
    const { path, value } = parseAssignment(text);
    setAt(copy, path, value);
  }
  const [major = '0', minor = '0'] = config.version.split('.');
  copy.version = `${major}.${minor}.${String(1000 + trial)}`;
  return strategyConfigSchema.parse(copy);
}

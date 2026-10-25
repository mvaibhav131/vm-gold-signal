import { SPLIT_KEYS, type SplitKey } from './backtest/splits';

/** The options of a command line: `--name value` (repeatable), `--flag`, and what is left over. */
export interface Args {
  readonly flags: ReadonlySet<string>;
  readonly values: ReadonlyMap<string, readonly string[]>;
  readonly positional: readonly string[];
}

/** Options that take a value; every other `--name` is a flag. */
const WITH_VALUE = new Set(['strategy', 'spread', 'notes', 'out', 'set', 'through', 'variant']);

export function parseArgs(argv: readonly string[]): Args {
  const flags = new Set<string>();
  const values = new Map<string, string[]>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (!WITH_VALUE.has(name)) {
      flags.add(name);
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`--${name} needs a value`);
    values.set(name, [...(values.get(name) ?? []), value]);
    i += 1;
  }
  return { flags, values, positional };
}

export const valueOf = (args: Args, name: string): string | undefined => args.values.get(name)?.[0];

/**
 * The last period the run goes through: `--through train|validation|test` (default validation). `--holdout` and
 * `--holdout-again` are the old names of `--through test`.
 */
export function throughOf(args: Args): SplitKey {
  const asked = valueOf(args, 'through');
  const holdout = args.flags.has('holdout') || args.flags.has('holdout-again');
  if (asked === undefined) return holdout ? 'TEST' : 'VALIDATION';
  const key = SPLIT_KEYS.find((candidate) => candidate === asked.toUpperCase());
  if (key === undefined)
    throw new Error(`--through is one of train, validation, test (not "${asked}")`);
  if (holdout && key !== 'TEST') throw new Error('--holdout means --through test');
  return key;
}

/**
 * The variants of an ablation: every `--variant "a=1;b=2"` is one variant (changes separated by `;`), and the
 * `--set` options together are one more, so that a single change can be written as before.
 */
export function variantsOf(args: Args): string[][] {
  const variants = (args.values.get('variant') ?? []).map((text) =>
    text
      .split(';')
      .map((part) => part.trim())
      .filter((part) => part !== ''),
  );
  const sets = args.values.get('set') ?? [];
  if (sets.length > 0) variants.push([...sets]);
  return variants.filter((variant) => variant.length > 0);
}

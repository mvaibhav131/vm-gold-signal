/** A value a test knows is there (an element of a list it just filled): fails with a clear error instead of `!`. */
export function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('a value was expected');
  return value;
}

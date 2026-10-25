import { describe, expect, it } from 'vitest';

import { parseArgs, throughOf, valueOf, variantsOf } from './args';

describe('parseArgs', () => {
  it('separates the options that take a value, the flags and the paths', () => {
    const args = parseArgs([
      '--strategy',
      'a,b',
      '--holdout',
      'data/x',
      '--spread',
      '0.3',
      'data/y',
    ]);
    expect(valueOf(args, 'strategy')).toBe('a,b');
    expect(valueOf(args, 'spread')).toBe('0.3');
    expect([...args.flags]).toEqual(['holdout']);
    expect(args.positional).toEqual(['data/x', 'data/y']);
  });

  it('keeps every value of an option that is given more than once, in order', () => {
    const args = parseArgs(['--set', 'a=1', '--set', 'b=2']);
    expect(args.values.get('set')).toEqual(['a=1', 'b=2']);
    expect(valueOf(args, 'set')).toBe('a=1');
  });

  it('knows no value for an option that was not given', () => {
    expect(valueOf(parseArgs([]), 'out')).toBeUndefined();
  });

  it('refuses an option without its value, at the end or before another option', () => {
    expect(() => parseArgs(['--notes'])).toThrow('--notes needs a value');
    expect(() => parseArgs(['--out', '--holdout'])).toThrow('--out needs a value');
  });

  it('takes a flag that it does not know as a flag', () => {
    expect([...parseArgs(['--dry-run', '--holdout-again']).flags]).toEqual([
      'dry-run',
      'holdout-again',
    ]);
  });
});

describe('throughOf', () => {
  const through = (...argv: string[]) => throughOf(parseArgs(argv));

  it('is the validation unless told otherwise, and reads the name in any case', () => {
    expect(through()).toBe('VALIDATION');
    expect(through('--through', 'train')).toBe('TRAIN');
    expect(through('--through', 'Validation')).toBe('VALIDATION');
    expect(through('--through', 'TEST')).toBe('TEST');
  });

  it('takes --holdout and --holdout-again as the old names of the test', () => {
    expect(through('--holdout')).toBe('TEST');
    expect(through('--holdout-again')).toBe('TEST');
    expect(through('--holdout', '--through', 'test')).toBe('TEST');
  });

  it('refuses a name that is no period, and a holdout that is told to stop earlier', () => {
    expect(() => through('--through', 'future')).toThrow('one of train, validation, test');
    expect(() => through('--holdout', '--through', 'train')).toThrow(
      '--holdout means --through test',
    );
  });
});

describe('variantsOf', () => {
  const variants = (...argv: string[]) => variantsOf(parseArgs(argv));

  it('reads each --variant as one variant, its changes separated by semicolons', () => {
    expect(variants('--variant', 'a=1;b=[1,2]', '--variant', 'c=3')).toEqual([
      ['a=1', 'b=[1,2]'],
      ['c=3'],
    ]);
  });

  it('takes the --set options together as one more variant, after the others', () => {
    expect(variants('--variant', 'a=1', '--set', 'b=2', '--set', 'c=3')).toEqual([
      ['a=1'],
      ['b=2', 'c=3'],
    ]);
  });

  it('leaves out an empty variant, and has none without options', () => {
    expect(variants('--variant', ' ; ')).toEqual([]);
    expect(variants()).toEqual([]);
  });
});

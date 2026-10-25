import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { strToU8, zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { filesOf, sourcesOf } from './files';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'vmgs-research-'));
  const zip = (csvName: string, text: string): Uint8Array => zipSync({ [csvName]: strToU8(text) });
  // the zip names say nothing about the order; the csv names inside do
  writeFileSync(join(dir, 'a.zip'), zip('DAT_ASCII_XAUUSD_M1_202601.csv', 'x\n'));
  writeFileSync(join(dir, 'b.zip'), zip('DAT_ASCII_XAUUSD_M1_2025.csv', 'y\n'));
  writeFileSync(join(dir, 'c.CSV'), 'DAT_ASCII_XAUUSD_M1_202602.csv is not its name\n');
  writeFileSync(join(dir, 'notes.txt'), 'ignored');
  mkdirSync(join(dir, 'nested'));
  mkdirSync(join(dir, 'empty'));
  writeFileSync(join(dir, 'nested', 'd.zip'), zip('DAT_ASCII_XAUUSD_M1_2024.csv', 'z\n'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('filesOf', () => {
  it('takes the zips and csvs of a folder, and not its other files or its sub folders', () => {
    expect(
      filesOf([dir])
        .map((path) => path.slice(dir.length + 1))
        .sort(),
    ).toEqual(['a.zip', 'b.zip', 'c.CSV']);
  });

  it('takes a file as it is, whatever its extension', () => {
    const file = join(dir, 'notes.txt');
    expect(filesOf([file])).toEqual([file]);
  });

  it('reads a relative path from the base it is given, not from the working folder', () => {
    const names = filesOf(['.'], join(dir, 'nested')).map((path) => path.slice(dir.length + 1));
    expect(names).toEqual([join('nested', 'd.zip')]);
    expect(filesOf(['b.zip'], dir)).toEqual([join(dir, 'b.zip')]);
    expect(sourcesOf(['nested'], dir).map((source) => source.name)).toEqual([
      'DAT_ASCII_XAUUSD_M1_2024.csv',
    ]);
  });

  it('joins several paths in the order given', () => {
    const file = join(dir, 'b.zip');
    expect(filesOf([file, join(dir, 'nested')])).toEqual([file, join(dir, 'nested', 'd.zip')]);
  });
});

describe('sourcesOf', () => {
  it('sorts by the name of the csv inside, not by the name of the zip', () => {
    const names = sourcesOf([join(dir, 'a.zip'), join(dir, 'b.zip'), join(dir, 'nested')]).map(
      (source) => source.name,
    );
    expect(names).toEqual([
      'DAT_ASCII_XAUUSD_M1_2024.csv',
      'DAT_ASCII_XAUUSD_M1_2025.csv',
      'DAT_ASCII_XAUUSD_M1_202601.csv',
    ]);
  });

  it('reads the lines of each file', () => {
    const [first] = sourcesOf([join(dir, 'b.zip')]);
    expect([...(first?.lines ?? [])]).toEqual(['y']);
  });

  it('refuses a folder with nothing to read', () => {
    expect(() => sourcesOf([join(dir, 'empty')])).toThrow('no .zip or .csv file found');
  });
});

import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { histSourceOf, linesOf } from './archive';

const bytes = (text: string): Uint8Array => strToU8(text);
const read = (data: Uint8Array): string[] => [...linesOf(data)];

describe('linesOf', () => {
  it('splits on line feeds, keeps the last line without one, and no empty line after the last', () => {
    expect(read(bytes('a\nb\nc'))).toEqual(['a', 'b', 'c']);
    expect(read(bytes('a\nb\n'))).toEqual(['a', 'b']);
  });

  it('keeps the carriage return of a Windows file for the parser to trim', () => {
    expect(read(bytes('a\r\nb\r\n'))).toEqual(['a\r', 'b\r']);
  });

  it('keeps blank lines, and gives nothing for no data', () => {
    expect(read(bytes('a\n\nb'))).toEqual(['a', '', 'b']);
    expect(read(new Uint8Array())).toEqual([]);
  });

  it('reads UTF-8', () => {
    expect(read(bytes('€\nä'))).toEqual(['€', 'ä']);
  });
});

describe('histSourceOf', () => {
  const csv = '20230102 180000;1;2;0;1;0\n20230102 180100;1;2;0;1;0\n';

  it('reads the csv of a zip and leaves the status file next to it alone', () => {
    const zip = zipSync({
      'DAT_ASCII_XAUUSD_M1_2023.txt': bytes('Status: ok'),
      'DAT_ASCII_XAUUSD_M1_2023.csv': bytes(csv),
    });
    const source = histSourceOf('DAT_ASCII_XAUUSD_M1_2023.zip', zip);
    expect(source.name).toBe('DAT_ASCII_XAUUSD_M1_2023.csv');
    expect([...source.lines]).toEqual(csv.trimEnd().split('\n'));
  });

  it('matches the extension without regard to case', () => {
    const zip = zipSync({ 'DATA_M1_2023.CSV': bytes(csv) });
    expect(histSourceOf('DATA.ZIP', zip).name).toBe('DATA_M1_2023.CSV');
  });

  it('reads a csv that is not zipped, under its own name', () => {
    const source = histSourceOf('DAT_ASCII_XAUUSD_T_202301.csv', bytes(csv));
    expect(source.name).toBe('DAT_ASCII_XAUUSD_T_202301.csv');
    expect([...source.lines]).toHaveLength(2);
  });

  it('refuses a zip with no csv in it', () => {
    const zip = zipSync({ 'readme.txt': bytes('nothing') });
    expect(() => histSourceOf('empty.zip', zip)).toThrow('no .csv file inside empty.zip');
  });
});

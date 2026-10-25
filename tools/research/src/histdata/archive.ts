import { unzipSync } from 'fflate';

/** The lines of a text file held in memory, without a copy of the whole text: the files of a tick month are large. */
export function* linesOf(bytes: Uint8Array): Generator<string> {
  const decoder = new TextDecoder('utf-8');
  let start = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] === 0x0a) {
      yield decoder.decode(bytes.subarray(start, i));
      start = i + 1;
    }
  }
  if (start < bytes.length) yield decoder.decode(bytes.subarray(start));
}

export interface HistSource {
  /** The name of the data file (inside a zip: the `.csv` entry), which tells bars from ticks. */
  readonly name: string;
  readonly lines: Iterable<string>;
}

/**
 * A HistData download: the `.zip` (its single `.csv` is read, the status `.txt` next to it is left alone)
 * or an already unpacked `.csv`.
 */
export function histSourceOf(fileName: string, bytes: Uint8Array): HistSource {
  if (!/\.zip$/i.test(fileName)) return { name: fileName, lines: linesOf(bytes) };
  const entries = unzipSync(bytes, { filter: (entry) => /\.csv$/i.test(entry.name) });
  const names = Object.keys(entries).sort();
  const name = names[0];
  const data = name === undefined ? undefined : entries[name];
  if (name === undefined || data === undefined) throw new Error(`no .csv file inside ${fileName}`);
  return { name, lines: linesOf(data) };
}

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import { histSourceOf, type HistSource } from './histdata/archive';

/**
 * A folder stands for the `.zip` and `.csv` files in it (not the folders in it). A relative path is
 * read from `base`: `pnpm research` runs the tool inside its own folder, so the place the owner typed the
 * command in (`INIT_CWD`) is passed in.
 */
export function filesOf(paths: readonly string[], base: string = process.cwd()): string[] {
  return paths.flatMap((path) => {
    const full = resolve(base, path);
    return statSync(full).isDirectory()
      ? readdirSync(full)
          .filter((name) => /\.(zip|csv)$/i.test(name))
          .map((name) => join(full, name))
      : [full];
  });
}

/**
 * The files read and in time order: the `.csv` inside a HistData zip is named after its year or month
 * (`..._M1_2023.csv`, `..._M1_202601.csv`, `..._T_202301.csv`), whatever the zip itself is called.
 */
export function sourcesOf(paths: readonly string[], base: string = process.cwd()): HistSource[] {
  const files = filesOf(paths, base);
  if (files.length === 0) throw new Error('no .zip or .csv file found');
  return files
    .map((path) => histSourceOf(basename(path), readFileSync(path)))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

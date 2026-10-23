import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

// 05_UI_Spec section 1: the initial route stays under 400 KB gzip (JS plus CSS).
// Reads the built index.html, adds up what it loads eagerly and fails the build above the budget.
const BUDGET_BYTES = 400 * 1024;
const dist = join(process.cwd(), 'apps', 'web', 'dist');

function eagerFiles(html) {
  const files = new Set();
  for (const match of html.matchAll(/<(?:script|link)\b[^>]*>/g)) {
    const tag = match[0];
    const isStyle = /rel=["']stylesheet["']/.test(tag);
    const isPreload = /rel=["']modulepreload["']/.test(tag);
    const isScript = tag.startsWith('<script') && /type=["']module["']/.test(tag);
    if (!isStyle && !isPreload && !isScript) continue;
    const ref = /(?:src|href)=["']([^"']+)["']/.exec(tag);
    if (ref?.[1]?.startsWith('/')) files.add(ref[1].slice(1));
  }
  return [...files];
}

let html;
try {
  html = readFileSync(join(dist, 'index.html'), 'utf8');
} catch {
  process.stderr.write(
    'bundle-budget: apps/web/dist/index.html not found. Run "pnpm web:build" first.\n',
  );
  process.exit(1);
}

const files = eagerFiles(html);
if (files.length === 0) {
  process.stderr.write('bundle-budget: index.html loads no scripts or styles.\n');
  process.exit(1);
}

let total = 0;
for (const file of files) {
  const size = gzipSync(readFileSync(join(dist, file))).length;
  total += size;
  process.stdout.write(`${(size / 1024).toFixed(1).padStart(8)} KB gzip  ${file}\n`);
}
const unused = readdirSync(join(dist, 'assets')).length - files.length;
process.stdout.write(
  `${(total / 1024).toFixed(1).padStart(8)} KB gzip  initial route (budget ${String(BUDGET_BYTES / 1024)} KB), ${String(unused)} lazy file(s) not counted\n`,
);

if (total > BUDGET_BYTES) {
  process.stderr.write('bundle-budget: the initial route is over the budget.\n');
  process.exit(1);
}

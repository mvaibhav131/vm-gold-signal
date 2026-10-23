import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { PostgreSqlContainer } from '@testcontainers/postgresql';

import { generateTypes } from '../src/codegen';
import { migrate } from '../src/migrate';
import { POSTGRES_IMAGE } from '../test/image';

// Starts a throw-away Postgres in Docker (random port, own labels), applies every migration,
// generates src/types.generated.ts from the result and removes the container again.
const outFile = fileURLToPath(new URL('../src/types.generated.ts', import.meta.url));

const container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
try {
  await migrate(container.getConnectionUri());
  const source = await generateTypes(container.getConnectionUri());
  await writeFile(outFile, source, 'utf8');
  process.stdout.write(`wrote ${outFile}\n`);
} finally {
  await container.stop();
}

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';

import { POSTGRES_IMAGE } from './image';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Superuser connection string of the shared test Postgres. */
    pgAdminUrl: string;
  }
}

/**
 * One Postgres container for the whole integration run, on a random host port and with its own
 * Testcontainers labels: it never touches containers or ports of other projects. The container is
 * removed when the run ends (Testcontainers' Ryuk also removes it if the run is killed).
 */
export default async function setup(project: TestProject) {
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
  project.provide('pgAdminUrl', container.getConnectionUri());
  return async () => {
    await container.stop();
  };
}

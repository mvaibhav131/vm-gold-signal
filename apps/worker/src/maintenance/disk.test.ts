import { describe, expect, it } from 'vitest';

import { NoDisk, databaseOnThisMachine } from './disk';

describe('databaseOnThisMachine', () => {
  it('is true for the compose stack, a local Postgres and Docker Desktop', () => {
    for (const host of ['db', 'localhost', '127.0.0.1', '[::1]', 'host.docker.internal', 'DB']) {
      expect(databaseOnThisMachine(`postgres://vmgs_worker:pw@${host}:5432/vmgs`), host).toBe(true);
    }
  });

  it('is false for a database at a host, such as Aiven, and for an address that cannot be read', () => {
    expect(
      databaseOnThisMachine(
        'postgres://vmgs_worker:pw@pg-1234-proj.aivencloud.com:12345/vmgs?sslmode=require',
      ),
    ).toBe(false);
    expect(databaseOnThisMachine('postgres://vmgs_worker:pw@10.0.0.5:5432/vmgs')).toBe(false);
    expect(databaseOnThisMachine('postgres://vmgs_worker:pw@db.example.com/vmgs')).toBe(false);
    expect(databaseOnThisMachine('not an address')).toBe(false);
    expect(databaseOnThisMachine('')).toBe(false);
  });
});

describe('NoDisk', () => {
  it('knows no disk', async () => {
    expect(await new NoDisk().usage()).toBeNull();
  });
});

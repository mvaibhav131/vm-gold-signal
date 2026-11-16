import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

async function read(path: string): Promise<string> {
  const text = await readFile(new URL(path, import.meta.url), 'utf8');
  return text.replaceAll('\r\n', '\n');
}

describe('the Dockerfile at the root of the repository', () => {
  it('is the same text as deploy/Dockerfile: a host that builds from the repository looks for ./Dockerfile', async () => {
    expect(await read('../../../../Dockerfile')).toBe(await read('../../../../deploy/Dockerfile'));
  });

  it('ends with the stage `all`, which is what a plain `docker build .` builds: the worker unless VMGS_ROLE says otherwise', async () => {
    const text = await read('../../../../Dockerfile');
    const stages = [...text.matchAll(/^FROM\s+\S+\s+AS\s+(\w+)/gm)];
    expect(stages.at(-1)?.[1]).toBe('all');
    // the compose stack builds `app` and `web`: they stay
    expect(stages.map((stage) => stage[1])).toEqual(expect.arrayContaining(['app', 'web', 'all']));
    // the entry point is the script that reads VMGS_ROLE (started through bash, so that it does not need an executable
    // bit: a builder that ignores `COPY --chmod` and a script made on Windows would otherwise give "Permission denied"),
    // and its default is the worker
    expect(text).toContain('ENTRYPOINT ["/sbin/tini", "--", "bash", "/opt/vmgs/bin/entry.sh"]');
    expect(text).toContain('RUN chmod 755 /opt/vmgs/bin/entry.sh');
    expect(await read('../../../../deploy/scripts/entry.sh')).toContain(
      'role="${VMGS_ROLE:-worker}"',
    );
  });
});

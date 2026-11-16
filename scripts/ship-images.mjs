// Builds the images of a release on this PC and writes them to one file, so that a small VM (the Google Cloud e2-micro,
// 1 GB of memory and a quarter of a CPU) never has to build: it only loads them. Plain Node, same in every shell.
//
//   pnpm ship:images [--arch amd64|arm64] [--out FILE] [--allow-dirty]
//
//   --arch   the processor of the VM: amd64 (default: the e2-micro and most VMs) or arm64 (Oracle Ampere A1)
//   --out    where to write the file (default: .local/vmgs-images-<release>-<arch>.tar.gz, which is never committed)
//
// It refuses a checkout with uncommitted changes (what you ship should be a commit that the VM can also check out).
// The database image is not in the file: the VM pulls it from Docker Hub. Then:
//   scp .local/vmgs-images-....tar.gz YOUR_USER@VM_IP:~/
//   sudo /opt/vmgs/deploy/scripts/deploy.sh --first --images ~/vmgs-images-....tar.gz
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createGzip } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ARCHES = ['amd64', 'arm64'];

class Failure extends Error {}

function parseArguments(argv) {
  const options = { arch: 'amd64', out: null, allowDirty: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--arch') {
      options.arch = argv[(index += 1)] ?? '';
    } else if (argument === '--out') {
      options.out = argv[(index += 1)] ?? '';
    } else if (argument === '--allow-dirty') {
      options.allowDirty = true;
    } else {
      throw new Failure(
        `unknown argument ${argument}: pnpm ship:images [--arch amd64|arm64] [--out FILE] [--allow-dirty]`,
      );
    }
  }
  if (!ARCHES.includes(options.arch))
    throw new Failure(`--arch is amd64 or arm64, not "${options.arch}"`);
  if (options.out === '') throw new Failure('--out needs a file name');
  return options;
}

function capture(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' });
  if (result.error !== undefined || result.status !== 0) {
    throw new Failure(
      `${command} ${args.join(' ')} failed: ${(result.stderr ?? '').trim() || String(result.error)}`,
    );
  }
  return result.stdout.trim();
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error !== undefined || result.status !== 0) {
    throw new Failure(`${command} ${args.join(' ')} failed (exit code ${String(result.status)})`);
  }
}

async function save(tags, file) {
  const child = spawn('docker', ['save', ...tags], { stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = new Promise((done, failed) => {
    child.on('error', failed);
    child.on('close', (code) => {
      if (code === 0) done();
      else failed(new Failure(`docker save failed (exit code ${String(code)})`));
    });
  });
  await Promise.all([
    pipeline(child.stdout, createGzip({ level: 6 }), createWriteStream(file)),
    exited,
  ]);
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function main() {
  const options = parseArguments(process.argv.slice(2));

  const dirty = capture('git', ['status', '--porcelain']);
  if (dirty !== '' && !options.allowDirty) {
    throw new Failure(
      'the checkout has uncommitted changes: commit them first (or --allow-dirty for a try).',
    );
  }
  const describe = capture('git', [
    'describe',
    '--tags',
    '--always',
    ...(dirty === '' ? [] : ['--dirty']),
  ]);
  // a Docker tag allows letters, digits, "_", "." and "-"
  const version = describe.replace(/[^A-Za-z0-9_.-]/g, '-');
  const app = `vmgs-app:${version}`;
  const web = `vmgs-web:${version}`;

  const docker = spawnSync('docker', ['info'], { stdio: 'ignore' });
  if (docker.error !== undefined || docker.status !== 0) {
    throw new Failure('Docker is not running. Start Docker Desktop and try again.');
  }

  const platform = `linux/${options.arch}`;
  process.stdout.write(
    `Building release ${version} for ${platform} (the first time takes several minutes).\n`,
  );
  // plain single-platform images, without attestation manifests, so that any Docker on the VM can load them
  const build = (target, tag) => {
    run('docker', [
      'build',
      '--platform',
      platform,
      '--provenance=false',
      '--sbom=false',
      '--file',
      'deploy/Dockerfile',
      '--target',
      target,
      '--tag',
      tag,
      '.',
    ]);
  };
  build('app', app);
  build('web', web);

  const out = resolve(
    options.out ?? join(root, '.local', `vmgs-images-${version}-${options.arch}.tar.gz`),
  );
  mkdirSync(dirname(out), { recursive: true });
  process.stdout.write(`Writing ${out}\n`);
  await save([app, web], out);
  const megabytes = Math.round(statSync(out).size / 1024 / 1024);
  const digest = await sha256(out);

  // the tags on this PC are not needed any more; the layers stay as the cache of the next build
  spawnSync('docker', ['image', 'rm', app, web], { stdio: 'ignore' });

  const name = out.split(/[\\/]/).pop();
  process.stdout.write(
    [
      '',
      `Made ${out} (${String(megabytes)} MB).`,
      `sha256 ${digest}`,
      '',
      'Copy it to the VM, check it, deploy:',
      `  scp "${out}" YOUR_USER@VM_IP:~/`,
      `  ssh YOUR_USER@VM_IP "sha256sum ~/${name}"      (the same number as above)`,
      `  sudo /opt/vmgs/deploy/scripts/deploy.sh --first --images ~/${name}`,
      '',
    ].join('\n'),
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

// The whole system on this PC, for looking at it with real data (Docker must be running): the real worker on the real
// feed, the API, and the web app behind Caddy at https://localhost:18443. Plain Node, so the commands are the same in
// PowerShell, cmd, Git Bash, WSL, macOS and Linux.
//
//   pnpm local up        first time: makes the settings (random passwords, in .local/, never committed), builds the
//                        images (a few minutes) and starts everything
//   pnpm local owner     makes the login of the dashboard (asks the password twice; PowerShell and Windows Terminal hide
//                        what you type, Git Bash cannot)
//   pnpm local open      opens https://localhost:18443 (the browser warns about the certificate: it is made by Caddy for
//                        this PC only; choose Advanced, then Proceed to localhost)
//   pnpm local admin <command> [args]   the other owner commands: owner:password <name> (a forgotten password),
//                        owner:totp-off <name>, owner:status, sessions:revoke-all, throttle:reset
//   pnpm local import    puts the newest HistData months (data/histdata) in, so that the chart is full and the engine
//                        warms up at once; restarts the worker
//   pnpm local status    what is running and whether the worker is heard from
//   pnpm local logs [service]   the log (default: worker); stop with Ctrl+C
//   pnpm local down      stops everything, keeps the data
//   pnpm local reset [--yes]   stops everything and DELETES the data of this PC's copy (asks first)
//
// It uses its own Docker project (vmgs-local) and the ports 18080, 18443 and 15432 on 127.0.0.1 only. Nothing else
// on the PC is touched.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const project = 'vmgs-local';
const dir = join(root, '.local');
const cfg = join(dir, 'local.cfg');
const site = 'https://localhost:18443';

const say = (text = '') => process.stdout.write(`${text}\n`);
const hex = (bytes) => randomBytes(bytes).toString('hex');

class Failure extends Error {}

function readSetting(name) {
  const line = readFileSync(cfg, 'utf8')
    .split(/\r?\n/)
    .find((each) => each.startsWith(`${name}=`));
  if (line === undefined) throw new Failure(`${name} is not in ${cfg}`);
  return line.slice(name.length + 1);
}

function assertDocker() {
  const result = spawnSync('docker', ['info'], { stdio: 'ignore' });
  if (result.error !== undefined || result.status !== 0) {
    throw new Failure(
      'Docker is not running (or not installed). Start Docker Desktop, wait until it says the engine is running, and try again.',
    );
  }
}

function makeConfig() {
  mkdirSync(dir, { recursive: true });
  const lines = [
    '# Made by scripts/local-live.mjs for this PC only. Never committed (.local/ is ignored).',
    'PUBLIC_HOST=localhost',
    'VMGS_VERSION=local',
    'LOG_LEVEL=info',
    'COMPOSE_PROFILES=web',
    `POSTGRES_PASSWORD=${hex(24)}`,
    `DB_PASSWORD_WORKER=${hex(24)}`,
    `DB_PASSWORD_BACKUP=${hex(24)}`,
    `DB_PASSWORD_API=${hex(24)}`,
    `APP_ENCRYPTION_KEY=${hex(32)}`,
    'FEED_SYMBOLS=XAUUSD,DXY,XAGUSD',
    // the backup jobs are not run on this PC, but the compose file asks for their settings
    `BACKUP_AGE_RECIPIENT=age1${'q'.repeat(58)}`,
    'BACKUP_RCLONE_REMOTE=local:not-used-on-this-pc',
  ];
  writeFileSync(cfg, `${lines.join('\n')}\n`, 'ascii');
  say(`Made ${cfg} (random passwords for this PC).`);
}

/** Runs docker compose for this copy, with the screen and the keyboard of this terminal. */
function compose(more, options = {}) {
  const args = [
    'compose',
    '--project-name',
    project,
    '--env-file',
    cfg,
    '--file',
    'deploy/docker-compose.yml',
    '--file',
    'deploy/drills/local-web.yml',
    '--file',
    'deploy/drills/local-live.yml',
    ...more,
  ];
  const result = spawnSync('docker', args, { cwd: root, stdio: 'inherit' });
  if (options.allowInterrupt === true) return;
  if (result.error !== undefined || result.status !== 0) {
    throw new Failure(
      `docker compose ${more.join(' ')} failed (exit code ${String(result.status)})`,
    );
  }
}

/** The owner commands ask for passwords: with a terminal Docker gives them one (typing is hidden), without it they read a pipe. */
function ownerCommand(args) {
  const more = ['--profile', 'ops', 'run', '--rm'];
  if (process.stdin.isTTY !== true) {
    more.push('-T');
    process.stderr.write(
      'This terminal cannot hide what you type (PowerShell and Windows Terminal can); the password will show.\n',
    );
  }
  compose([...more, 'owner', ...args]);
}

/** pnpm is a script on Windows: it is started the way pnpm started this one when it can be. */
function runPnpm(args, env) {
  const execPath = process.env.npm_execpath;
  const direct = execPath !== undefined && /\.c?js$/.test(execPath);
  const result = direct
    ? spawnSync(process.execPath, [execPath, ...args], { cwd: root, env, stdio: 'inherit' })
    : spawnSync(`pnpm ${args.map((each) => `"${each}"`).join(' ')}`, {
        cwd: root,
        env,
        shell: true,
        stdio: 'inherit',
      });
  if (result.error !== undefined || result.status !== 0) throw new Failure('the import failed');
}

function openBrowser() {
  const [command, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', site]]
      : process.platform === 'darwin'
        ? ['open', [site]]
        : ['xdg-open', [site]];
  spawn(command, args, { detached: true, stdio: 'ignore' }).unref();
}

async function confirmReset(rest) {
  if (rest.includes('--yes')) return true;
  const lines = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await lines.question(
    "This DELETES the database of this PC's copy (recorded ticks, signals, the login). Type yes to go on: ",
  );
  lines.close();
  return answer.trim() === 'yes';
}

function help() {
  const lines = readFileSync(fileURLToPath(import.meta.url), 'utf8').split(/\r?\n/);
  const block = [];
  for (const line of lines) {
    if (!line.startsWith('//')) break;
    block.push(line.replace(/^\/\/ ?/, ''));
  }
  say(block.join('\n'));
}

async function main() {
  const [command = 'help', ...rest] = process.argv.slice(2);
  switch (command) {
    case 'up':
      assertDocker();
      if (!existsSync(cfg)) makeConfig();
      compose(['up', '-d', '--build']);
      say();
      say(
        `Running. Open ${site} (the browser warns about the certificate: Advanced, then Proceed to localhost).`,
      );
      say(
        'No login yet? pnpm local owner     More data for the chart? pnpm local import     State: pnpm local status',
      );
      break;
    case 'owner':
      assertDocker();
      ownerCommand(['owner:create', rest[0] ?? 'owner']);
      break;
    case 'admin':
      assertDocker();
      if (rest.length === 0) {
        throw new Failure(
          'say which: owner:password <name> | owner:totp-off <name> | owner:status | sessions:revoke-all | throttle:reset',
        );
      }
      ownerCommand(rest);
      break;
    case 'open':
      openBrowser();
      break;
    case 'import': {
      assertDocker();
      let files = rest;
      if (files.length === 0) {
        // the newest three months: 25 days of hourly candles are what the warm-up needs
        const folder = join(root, 'data', 'histdata');
        files = existsSync(folder)
          ? readdirSync(folder)
              .filter((name) => name.endsWith('.zip'))
              .sort()
              .slice(-3)
              .map((name) => join(folder, name))
          : [];
      }
      if (files.length === 0) {
        throw new Failure(
          'No HistData zips in data/histdata (docs/06, "HistData download and import").',
        );
      }
      say(`Importing: ${files.map((file) => file.split(/[\\/]/).pop()).join(', ')}`);
      const password = readSetting('DB_PASSWORD_WORKER');
      runPnpm(['research', 'histdata:import', ...files], {
        ...process.env,
        DATABASE_URL_WORKER: `postgres://vmgs_worker:${password}@127.0.0.1:15432/vmgs`,
      });
      // the engine warms up from the stored candles when the worker starts
      compose(['restart', 'worker']);
      say('The worker was restarted: it warms up from the history now.');
      break;
    }
    case 'status':
      assertDocker();
      compose(['ps']);
      say();
      compose([
        'exec',
        '-T',
        'worker',
        'node',
        '--import',
        'tsx',
        'src/cli/main.ts',
        'worker:alive',
        '60',
      ]);
      break;
    case 'logs':
      assertDocker();
      compose(['logs', '--follow', '--tail', '50', rest[0] ?? 'worker'], { allowInterrupt: true });
      break;
    case 'down':
      assertDocker();
      compose(['--profile', 'web', '--profile', 'ops', 'down']);
      say('Stopped. The data is kept: pnpm local up starts it again.');
      break;
    case 'reset':
      assertDocker();
      if (!(await confirmReset(rest))) {
        say('Nothing was deleted.');
        break;
      }
      compose(['--profile', 'web', '--profile', 'ops', 'down', '--volumes']);
      say('Deleted. pnpm local up makes a new, empty one.');
      break;
    default:
      help();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

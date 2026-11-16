// Sets up the free database on Aiven for this system, and makes the lists of settings for the two containers: the worker
// and the website. Plain Node: the same in PowerShell, cmd and Git Bash. Nothing is sent anywhere but to YOUR Aiven database.
//
//   pnpm aiven setup     asks for the Service URI of your Aiven database (hidden while you paste it) and the place of its
//                        ca.pem; makes the passwords and the key of the login; sets up the tables and the roles; imports the
//                        newest history if you have the HistData zips; asks for the Telegram token and the Healthchecks link
//                        (Enter skips); writes .local/back4app-vars.txt (the worker) and .local/back4app-site-vars.txt (the
//                        website): the settings to paste into the host of each container
//   pnpm aiven import    imports the newest three HistData zips (data/histdata) into the database again
//   pnpm aiven status    asks the database whether the worker is running: "ALIVE" or not
//   pnpm aiven link      makes the code that links your Telegram chat to the bot: send the bot  /link <code>
//   pnpm aiven test      queues a test message; the running worker sends it to Telegram within seconds
//   pnpm aiven site <address>   once the host has given the website its address (myname.b4a.run): writes it into the
//                        settings of the website
//   pnpm aiven owner [name]     makes the login of the dashboard (asks for the password twice)
//   pnpm aiven admin <command>  the other owner commands: owner:password <name> (forgotten password), owner:totp-off <name>,
//                        owner:status, sessions:revoke-all, throttle:reset
//
// The settings are kept in .local/aiven.cfg and the two .local/back4app-*.txt files: they hold passwords, are never
// committed (.local/ is ignored) and must never be sent to anyone.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, '.local');
const cfgFile = join(dir, 'aiven.cfg');
const varsFile = join(dir, 'back4app-vars.txt');
const siteVarsFile = join(dir, 'back4app-site-vars.txt');
const defaultCa = join(dir, 'aiven-ca.pem');

class Failure extends Error {}

const say = (text = '') => process.stdout.write(`${text}\n`);
const hex = (bytes) => randomBytes(bytes).toString('hex');

function readAll(stream) {
  return new Promise((done, failed) => {
    let text = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      text += chunk;
    });
    stream.on('end', () => {
      done(text);
    });
    stream.on('error', failed);
  });
}

/** Questions on a terminal (what you type can be hidden), or answers from a pipe, one line each. */
async function makePrompter() {
  if (process.stdin.isTTY !== true) {
    const lines = (await readAll(process.stdin)).split(/\r?\n/);
    return {
      ask(text) {
        say(text);
        return Promise.resolve((lines.shift() ?? '').trim());
      },
      close() {
        // a pipe has nothing to close
      },
    };
  }
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, done) {
      if (!muted) process.stdout.write(chunk);
      done();
    },
  });
  const lines = createInterface({ input: process.stdin, output, terminal: true });
  return {
    ask(text, { secret = false } = {}) {
      return new Promise((done) => {
        process.stdout.write(text);
        muted = secret;
        lines.question('', (answer) => {
          muted = false;
          if (secret) process.stdout.write('\n');
          done(answer.trim());
        });
      });
    },
    close() {
      lines.close();
    },
  };
}

function loadConfig() {
  if (!existsSync(cfgFile)) return null;
  const config = {};
  for (const line of readFileSync(cfgFile, 'utf8').split(/\r?\n/)) {
    const index = line.indexOf('=');
    if (index > 0 && !line.startsWith('#')) config[line.slice(0, index)] = line.slice(index + 1);
  }
  return config;
}

function writeSecretFile(file, text) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, text, 'utf8');
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows has no file modes: the folder of your own account is the protection
  }
}

function saveConfig(config) {
  const lines = [
    '# Made by pnpm aiven. Holds passwords: never commit it, never send it to anyone.',
  ];
  for (const [key, value] of Object.entries(config)) {
    if (value !== undefined && value !== '') lines.push(`${key}=${value}`);
  }
  writeSecretFile(cfgFile, `${lines.join('\n')}\n`);
}

/** Finds the postgres:// address in what was pasted (also when it is inside `psql '...'`). */
function parseServiceUri(text) {
  const match = /postgres(?:ql)?:\/\/[^\s'"]+/.exec(text);
  if (match === null) {
    throw new Failure(
      'That is not a Service URI. It starts with postgres:// and is on the Overview page of your service in Aiven.',
    );
  }
  const url = new URL(match[0]);
  if (url.hostname === '' || url.password === '') {
    throw new Failure(
      'The Service URI has no host or no password: copy the whole line, including the password.',
    );
  }
  return {
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    host: url.hostname,
    port: url.port === '' ? '5432' : url.port,
    database:
      url.pathname.replace(/^\//, '') === '' ? 'defaultdb' : url.pathname.replace(/^\//, ''),
  };
}

function adminUrl(target) {
  const encode = encodeURIComponent;
  return `postgres://${encode(target.user)}:${encode(target.password)}@${target.host}:${target.port}/${target.database}?sslmode=require`;
}

function roleUrl(config, role, password) {
  return `postgres://${role}:${password}@${config.AIVEN_HOST}:${config.AIVEN_PORT}/${config.AIVEN_DB}?sslmode=require`;
}

function readCa(path) {
  if (!existsSync(path)) {
    throw new Failure(
      `There is no file at ${path}. In Aiven, on the Overview page of your service, download the CA certificate (ca.pem) and save it there.`,
    );
  }
  const text = readFileSync(path, 'utf8');
  if (!text.includes('-----BEGIN CERTIFICATE-----')) {
    throw new Failure(
      `${path} is not a certificate file (it should start with -----BEGIN CERTIFICATE-----).`,
    );
  }
  return text.trim();
}

const oneLine = (pem) => pem.replaceAll(/\r?\n/g, '\\n');

/** Runs a pnpm script of this repository with a clean environment plus `extra`; returns the exit code. */
function pnpm(args, extra) {
  const env = { ...process.env, ...extra };
  delete env.NODE_TLS_REJECT_UNAUTHORIZED;
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
  return result.status ?? 1;
}

function newestZips() {
  const folder = join(root, 'data', 'histdata');
  if (!existsSync(folder)) return [];
  return readdirSync(folder)
    .filter((name) => name.endsWith('.zip'))
    .sort()
    .slice(-3)
    .map((name) => join(folder, name));
}

function importHistory(config, caText) {
  const zips = newestZips();
  if (zips.length === 0) {
    say(
      'No HistData zips in data/histdata, so no history is imported. The chart fills as live prices come in.',
    );
    say(
      '(Later: put the zips there and run  pnpm aiven import . How to get them: docs/06, "HistData download and import".)',
    );
    return true;
  }
  say(
    `Importing ${String(zips.length)} months of history (${zips.map((zip) => zip.split(/[\\/]/).pop()).join(', ')}) ...`,
  );
  const code = pnpm(['research', 'histdata:import', ...zips], {
    DATABASE_URL_WORKER: roleUrl(config, 'vmgs_worker', config.DB_PASSWORD_WORKER),
    DATABASE_CA_PEM: oneLine(caText),
  });
  if (code !== 0) throw new Failure('The history import failed (the message is above).');
  return true;
}

function varsText(config, caText) {
  const lines = [
    '# The settings of the WORKER container. Paste each line into the host of the container.',
    '# (Back4app: your app > Settings > Environment variables.) Each line is NAME=value: the name before the first =.',
    '# This file holds passwords: never commit it, never send it to anyone.',
    'VMGS_ROLE=worker',
    'NODE_ENV=production',
    'LOG_LEVEL=info',
    'PUBLIC_HOST=localhost',
    'FEED_PROVIDER=biquote',
    'FEED_SYMBOLS=XAUUSD,DXY,XAGUSD',
    'PORT=8080',
    // the free Aiven database allows 20 connections for everything: the worker, the website and you
    'DATABASE_POOL_MAX=6',
    `DATABASE_URL_WORKER=${roleUrl(config, 'vmgs_worker', config.DB_PASSWORD_WORKER)}`,
    `DATABASE_CA_PEM=${oneLine(caText)}`,
  ];
  if (config.TELEGRAM_BOT_TOKEN) lines.push(`TELEGRAM_BOT_TOKEN=${config.TELEGRAM_BOT_TOKEN}`);
  if (config.HEALTHCHECKS_PING_URL)
    lines.push(`HEALTHCHECKS_PING_URL=${config.HEALTHCHECKS_PING_URL}`);
  return `${lines.join('\n')}\n`;
}

/** The host name (no https://, no path) of the website, from what the host shows: its address or only its name. */
function parseSiteHost(text) {
  const cleaned = text.trim().replace(/^https?:\/\//i, '');
  const host = cleaned.split(/[/?#]/)[0] ?? '';
  if (
    !/^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(
      host,
    )
  ) {
    throw new Failure(
      `"${text}" is not a website address. Give the address that the host shows for the container, for example myname.b4a.run (with or without https://).`,
    );
  }
  return host.toLowerCase();
}

function siteVarsText(config, caText, host) {
  const lines = [
    '# The settings of the WEBSITE container (the api and the dashboard). Paste each line into the host of that container.',
    '# It is a second container made from the same repository; VMGS_ROLE=site is what makes it the website.',
    '# This file holds passwords: never commit it, never send it to anyone.',
    'VMGS_ROLE=site',
    'NODE_ENV=production',
    'LOG_LEVEL=info',
    `PUBLIC_HOST=${host}`,
    'PORT=8080',
    // this Caddy and the proxy of the host: see deploy/Caddyfile.site
    'API_TRUSTED_PROXY_HOPS=2',
    'DATABASE_POOL_MAX=4',
    `DATABASE_URL_API=${roleUrl(config, 'vmgs_api', config.DB_PASSWORD_API)}`,
    `DATABASE_CA_PEM=${oneLine(caText)}`,
    `APP_ENCRYPTION_KEY=${config.APP_ENCRYPTION_KEY}`,
  ];
  return `${lines.join('\n')}\n`;
}

/** What the commands of the api (making the owner) need to reach the database from this PC. */
function apiEnv(config) {
  return {
    DATABASE_URL_API: roleUrl(config, 'vmgs_api', config.DB_PASSWORD_API),
    DATABASE_CA_PEM: oneLine(readCa(config.AIVEN_CA_FILE)),
  };
}

function writeSiteVars(config, host) {
  writeSecretFile(siteVarsFile, siteVarsText(config, readCa(config.AIVEN_CA_FILE), host));
  saveConfig({ ...config, SITE_HOST: host });
}

async function setup() {
  say(
    'Aiven setup. It asks for 2 things (3 with Telegram) and does the rest. Nothing leaves your PC except to your own',
  );
  say('Aiven database. Passwords are never shown on the screen.\n');
  const prompt = await makePrompter();
  try {
    say(
      '1. In Aiven: open your PostgreSQL service > Overview. Copy the "Service URI" (the whole line, it starts with postgres://).',
    );
    const target = parseServiceUri(
      await prompt.ask('   Paste it here (it stays hidden) and press Enter: ', { secret: true }),
    );
    say(
      `   Got it: host ${target.host}, port ${target.port}, database ${target.database}, user ${target.user}.\n`,
    );

    say('2. On the same page, download the CA certificate (ca.pem).');
    const wanted = await prompt.ask(
      `   Where is the file? Press Enter for ${defaultCa}, or type the path: `,
    );
    const caPath = resolve(wanted === '' ? defaultCa : wanted.replaceAll(/^"|"$/g, ''));
    const caText = readCa(caPath);
    say('   The certificate is fine.\n');

    const saved = loadConfig();
    const same =
      saved !== null && saved.AIVEN_HOST === target.host && saved.AIVEN_PORT === target.port;
    const config = {
      AIVEN_HOST: target.host,
      AIVEN_PORT: target.port,
      AIVEN_DB: target.database,
      AIVEN_CA_FILE: caPath,
      // the same passwords on a second run: a worker that is already running keeps working
      DB_PASSWORD_WORKER: same ? saved.DB_PASSWORD_WORKER : hex(24),
      DB_PASSWORD_API: same ? saved.DB_PASSWORD_API : hex(24),
      DB_PASSWORD_BACKUP: same ? saved.DB_PASSWORD_BACKUP : hex(24),
      // the key of the login of the website (the second step of the login is encrypted with it): kept, never changed
      // by a second run, or the second step of the login would become unreadable
      APP_ENCRYPTION_KEY: same && saved.APP_ENCRYPTION_KEY ? saved.APP_ENCRYPTION_KEY : hex(32),
      SITE_HOST: same ? saved.SITE_HOST : undefined,
      TELEGRAM_BOT_TOKEN: same ? saved.TELEGRAM_BOT_TOKEN : undefined,
      HEALTHCHECKS_PING_URL: same ? saved.HEALTHCHECKS_PING_URL : undefined,
    };
    if (same) say('   (This database was set up before: its saved passwords are used again.)\n');

    say('3. Setting up the tables and the three roles in your Aiven database ...');
    const code = pnpm(['cli', 'db:migrate'], {
      DATABASE_URL_ADMIN: adminUrl(target),
      NODE_EXTRA_CA_CERTS: caPath,
      DB_PASSWORD_WORKER: config.DB_PASSWORD_WORKER,
      DB_PASSWORD_API: config.DB_PASSWORD_API,
      DB_PASSWORD_BACKUP: config.DB_PASSWORD_BACKUP,
    });
    saveConfig(config);
    if (code !== 0) {
      throw new Failure(
        'The setup stopped (the message is above). Nothing is broken: fix what it says and run this again.',
      );
    }
    say('   Done. ("migration 5 ran its fallback file" is normal on Aiven.)\n');

    say('4. History for the chart and the warm-up of the engine.');
    importHistory(config, caText);
    say();

    say('5. Telegram: paste the token of your bot (it stays hidden), or press Enter to skip.');
    const keepToken = config.TELEGRAM_BOT_TOKEN ? ' (Enter keeps the saved one)' : '';
    const token = await prompt.ask(`   Token${keepToken}: `, { secret: true });
    if (token !== '') config.TELEGRAM_BOT_TOKEN = token;
    say(
      '6. Healthchecks.io: paste the ping link of the "worker" check (https://hc-ping.com/...), or press Enter to skip.',
    );
    const keepPing = config.HEALTHCHECKS_PING_URL ? ' (Enter keeps the saved one)' : '';
    const ping = await prompt.ask(`   Link${keepPing}: `);
    if (ping !== '') config.HEALTHCHECKS_PING_URL = ping;

    saveConfig(config);
    writeSecretFile(varsFile, varsText(config, caText));
    // the website's settings, with a name that is replaced once the host has given the address (pnpm aiven site)
    writeSiteVars(config, config.SITE_HOST ?? 'pending.invalid');
    say();
    say('All done. The database is ready.');
    say(`The settings for the WORKER container are in:  ${varsFile}`);
    say(`The settings for the WEBSITE container are in: ${siteVarsFile}`);
    say(
      'Open them (Windows: notepad .local\\back4app-vars.txt) and paste their lines into the host of each container.',
    );
    say('They hold passwords: do not commit them and do not send them to anyone, not even to me.');
    say('When the worker runs, check it from here with:  pnpm aiven status');
    say(
      'When the website container has its address:  pnpm aiven site <the address>  and then  pnpm aiven owner  (your login).',
    );
  } finally {
    prompt.close();
  }
}

function requireConfig() {
  const config = loadConfig();
  if (config === null || !config.AIVEN_HOST) {
    throw new Failure('Nothing is set up yet. Run  pnpm aiven setup  first.');
  }
  return config;
}

/** What the commands of the worker need to reach the database (and the bot) from this PC. */
function workerEnv(config) {
  return {
    DATABASE_URL_WORKER: roleUrl(config, 'vmgs_worker', config.DB_PASSWORD_WORKER),
    DATABASE_CA_PEM: oneLine(readCa(config.AIVEN_CA_FILE)),
    FEED_PROVIDER: 'biquote',
    PUBLIC_HOST: 'localhost',
    ...(config.TELEGRAM_BOT_TOKEN ? { TELEGRAM_BOT_TOKEN: config.TELEGRAM_BOT_TOKEN } : {}),
  };
}

function telegram(command) {
  const config = requireConfig();
  if (!config.TELEGRAM_BOT_TOKEN) {
    throw new Failure(
      'No Telegram token is saved. Run  pnpm aiven setup  again and paste it at step 5.',
    );
  }
  process.exitCode = pnpm(['cli', command], workerEnv(config));
}

async function site(argument) {
  const config = requireConfig();
  let text = argument;
  if (text === undefined) {
    const prompt = await makePrompter();
    try {
      text = await prompt.ask(
        'Address of the website container, as the host shows it (for example myname.b4a.run): ',
      );
    } finally {
      prompt.close();
    }
  }
  const host = parseSiteHost(text);
  writeSiteVars(config, host);
  say(`The settings of the website are written for ${host}:  ${siteVarsFile}`);
  say(
    'Paste the line  PUBLIC_HOST=' +
      host +
      '  into the website container (replace the old value) and deploy it again.',
  );
  say('Then open  https://' + host + '  and log in. No login yet?  pnpm aiven owner');
}

/** The owner commands of the website (the login), run from this PC against the database. */
function ownerCommand(args) {
  const config = requireConfig();
  process.exitCode = pnpm(['api:cli', ...args], apiEnv(config));
}

async function importOnly() {
  const config = requireConfig();
  importHistory(config, readCa(config.AIVEN_CA_FILE));
}

function status() {
  const config = requireConfig();
  say(
    'Asking your Aiven database whether the worker has written its heartbeat in the last 2 minutes ...',
  );
  const code = pnpm(['cli', 'worker:alive', '120'], workerEnv(config));
  say();
  if (code === 0) {
    say('ALIVE: the worker is running and recording.');
  } else {
    say('NOT ALIVE: no fresh heartbeat. The worker container is not running yet, or it stopped.');
    say('Look at its log in the host of the container (the last lines tell why).');
    process.exitCode = 1;
  }
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
    case 'setup':
      await setup();
      break;
    case 'import':
      await importOnly();
      break;
    case 'status':
      status();
      break;
    case 'link':
      telegram('telegram:link');
      break;
    case 'test':
      telegram('telegram:test');
      break;
    case 'site':
      await site(rest[0]);
      break;
    case 'owner':
      ownerCommand(['owner:create', rest[0] ?? 'owner']);
      break;
    case 'admin':
      if (rest.length === 0) {
        throw new Failure(
          'say which: owner:password <name> | owner:totp-off <name> | owner:status | sessions:revoke-all | throttle:reset',
        );
      }
      ownerCommand(rest);
      break;
    default:
      help();
  }
}

main().catch((error) => {
  process.stderr.write(`\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

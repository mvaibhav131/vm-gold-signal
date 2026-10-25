import { describe, expect, it } from 'vitest';

import {
  BOT_COMMANDS,
  MAX_PAUSE_MINUTES,
  linkCodeOf,
  parseCommand,
  pauseArgument,
} from './commands';

describe('parseCommand', () => {
  it('reads every command of the bot, in any case', () => {
    for (const name of BOT_COMMANDS) {
      expect(parseCommand(`/${name}`)).toEqual({ command: name, args: [] });
      expect(parseCommand(`/${name.toUpperCase()}`)).toEqual({ command: name, args: [] });
    }
    expect(BOT_COMMANDS).toEqual([
      'start',
      'help',
      'status',
      'open',
      'last',
      'today',
      'month',
      'pause',
      'resume',
      'link',
    ]);
  });

  it('takes the words after the command as arguments, whatever the spaces', () => {
    expect(parseCommand('/pause 30')).toEqual({ command: 'pause', args: ['30'] });
    expect(parseCommand('  /link   1234-5678  ')).toEqual({ command: 'link', args: ['1234-5678'] });
    expect(parseCommand('/pause\n45')).toEqual({ command: 'pause', args: ['45'] });
    expect(parseCommand('/open now please')).toEqual({ command: 'open', args: ['now', 'please'] });
  });

  it('is not a command when it does not start with a slash and a name', () => {
    for (const text of ['', '  ', 'status', 'hello /status', '/', '/ status', '//status', '/ß']) {
      expect(parseCommand(text), text).toBeNull();
    }
  });

  it('a command that is not the bot is unknown, with its name', () => {
    expect(parseCommand('/foo bar')).toEqual({ command: 'unknown', name: 'foo', args: ['bar'] });
    expect(parseCommand('/Stats')).toEqual({ command: 'unknown', name: 'stats', args: [] });
    // a name followed by something that is not a space is not a command name
    expect(parseCommand('/status!')).toBeNull();
  });

  it('accepts the form /command@bot for this bot only', () => {
    expect(parseCommand('/status@VmGoldBot', 'vmgoldbot')).toEqual({ command: 'status', args: [] });
    expect(parseCommand('/status@VmGoldBot', 'VmGoldBot')).toEqual({ command: 'status', args: [] });
    expect(parseCommand('/status@OtherBot', 'VmGoldBot')).toBeNull();
    // without a known bot name every address is accepted
    expect(parseCommand('/status@OtherBot')).toEqual({ command: 'status', args: [] });
    expect(parseCommand('/pause@VmGoldBot 15', 'VmGoldBot')).toEqual({
      command: 'pause',
      args: ['15'],
    });
  });
});

describe('pauseArgument', () => {
  it('has no end without an argument, and the minutes with one', () => {
    expect(pauseArgument([])).toEqual({ ok: true, minutes: null });
    expect(pauseArgument(['30'])).toEqual({ ok: true, minutes: 30 });
    expect(pauseArgument(['1'])).toEqual({ ok: true, minutes: 1 });
    expect(pauseArgument([String(MAX_PAUSE_MINUTES)])).toEqual({
      ok: true,
      minutes: MAX_PAUSE_MINUTES,
    });
  });

  it('refuses what the API would refuse', () => {
    for (const args of [
      ['0'],
      ['00'],
      [String(MAX_PAUSE_MINUTES + 1)],
      ['-5'],
      ['1.5'],
      ['abc'],
      ['30', '40'],
      ['123456'],
      [''],
    ]) {
      expect(pauseArgument(args), JSON.stringify(args)).toEqual({ ok: false });
    }
    expect(MAX_PAUSE_MINUTES).toBe(10_080);
  });
});

describe('linkCodeOf', () => {
  it('is the 8 digits, with or without the dash', () => {
    expect(linkCodeOf(['1234-5678'])).toBe('12345678');
    expect(linkCodeOf(['12345678'])).toBe('12345678');
  });

  it('is null for anything else', () => {
    for (const args of [
      [],
      ['1234567'],
      ['123456789'],
      ['1234-567'],
      ['abcd-efgh'],
      ['1', '2'],
      ['12-345678'],
      ['1234--5678'],
    ]) {
      expect(linkCodeOf(args), JSON.stringify(args)).toBeNull();
    }
  });
});

import type { Readable, Writable } from 'node:stream';

export interface TypedState {
  readonly value: string;
  readonly done: boolean;
  readonly cancelled: boolean;
}

export const EMPTY_TYPING: TypedState = { value: '', done: false, cancelled: false };

/**
 * What a terminal in raw mode delivers, applied to what has been typed so far: Enter ends it, Ctrl-C and Ctrl-D
 * cancel it, backspace removes a character, other control characters (and the rest of an arrow key's escape
 * sequence) are dropped. Nothing is echoed: a password is not written on the screen.
 */
export function typeInto(state: TypedState, chunk: string): TypedState {
  let { value } = state;
  for (const char of chunk) {
    if (char === '\r' || char === '\n') return { value, done: true, cancelled: false };
    if (char === '\u0003' || char === '\u0004') return { value, done: false, cancelled: true };
    if (char === '\u001b') break; // an escape sequence (an arrow key): ignore the rest of this chunk
    if (char === '\u007f' || char === '\b') value = Array.from(value).slice(0, -1).join('');
    else if (char >= ' ') value += char;
  }
  return { value, done: false, cancelled: false };
}

type RawInput = Readable & { setRawMode: (mode: boolean) => unknown };

/** A line typed at a terminal, without an echo. */
function readFromTerminal(input: RawInput, output: Writable, prompt: string): Promise<string> {
  output.write(prompt);
  return new Promise((resolve, reject) => {
    let state = EMPTY_TYPING;
    const finish = () => {
      input.removeListener('data', onData);
      input.setRawMode(false);
      input.pause();
      output.write('\n');
    };
    const onData = (chunk: Buffer | string) => {
      state = typeInto(state, chunk.toString());
      if (state.cancelled) {
        finish();
        reject(new Error('cancelled'));
      } else if (state.done) {
        finish();
        resolve(state.value);
      }
    };
    input.setRawMode(true);
    input.resume();
    input.on('data', onData);
  });
}

/** The first line of a pipe (`printf '%s\n' "$PASSWORD" | ...`). */
export async function firstLine(input: AsyncIterable<unknown>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of input) chunks.push(Buffer.from(chunk as Buffer));
  const text = Buffer.concat(chunks).toString('utf8');
  return (text.split('\n')[0] ?? '').replace(/\r$/, '');
}

export function isTerminal(input: Readable): boolean {
  return (input as { isTTY?: boolean }).isTTY === true;
}

/**
 * The owner's password for a command. At a terminal it is asked for without an echo; from a pipe it is the first
 * line (a pipe can be read once, so the commands ask for it once). It is never taken from an argument or the
 * environment: those show up in the list of processes and in the history of the shell.
 */
export function passwordReader(
  input: Readable,
  output: Writable,
): (prompt: string) => Promise<string> {
  return (prompt) =>
    isTerminal(input) ? readFromTerminal(input as RawInput, output, prompt) : firstLine(input);
}

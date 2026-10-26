import { describe, expect, it } from 'vitest';

import { emptyLoginForm, toLoginRequest, validateLoginForm } from './loginForm';

const filled = { username: 'owner', password: 'pw', totp: '' };

describe('the login form', () => {
  it('needs a user name and a password, and nothing else', () => {
    expect(validateLoginForm(emptyLoginForm)).toEqual({
      username: 'Enter your username',
      password: 'Enter your password',
    });
    expect(validateLoginForm(filled)).toEqual({});
  });

  it('takes six digits or a recovery code for the second step, and nothing else', () => {
    for (const good of ['123456', 'k7m2-q9x4', ' K7M2-Q9X4 ', '']) {
      expect(validateLoginForm({ ...filled, totp: good }), good).toEqual({});
    }
    for (const bad of [
      '12345',
      '1234567',
      '12ab',
      'k7m2q9x4',
      'k7m2-q9x',
      'k7m2-q9x45',
      'abc def',
    ]) {
      expect(validateLoginForm({ ...filled, totp: bad }), bad).toEqual({
        totp: 'The code has 6 digits',
      });
    }
  });

  it('sends the code as the API reads it: trimmed, in small letters, and left out when empty', () => {
    expect(toLoginRequest({ ...filled, totp: '' })).toEqual({ username: 'owner', password: 'pw' });
    expect(toLoginRequest({ ...filled, totp: '123456' }).totp).toBe('123456');
    expect(toLoginRequest({ ...filled, totp: '  K7M2-Q9X4 ' }).totp).toBe('k7m2-q9x4');
    expect(toLoginRequest({ ...filled, username: ' owner ' }).username).toBe('owner');
  });
});

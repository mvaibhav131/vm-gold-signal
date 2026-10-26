import { loginRequestSchema, type LoginRequest } from '@vmgs/contracts';

export interface LoginFormValues {
  username: string;
  password: string;
  /** Optional second factor, only for owners who enabled it. */
  totp: string;
}

export const emptyLoginForm: LoginFormValues = { username: '', password: '', totp: '' };

export function validateLoginForm(
  values: LoginFormValues,
): Partial<Record<keyof LoginFormValues, string>> {
  const errors: Partial<Record<keyof LoginFormValues, string>> = {};
  if (values.username.trim() === '') errors.username = 'Enter your username';
  if (values.password === '') errors.password = 'Enter your password';
  if (normalizeCode(values.totp) !== '' && !CODE_SHAPE.test(normalizeCode(values.totp))) {
    errors.totp = 'The code has 6 digits';
  }
  return errors;
}

/** Six digits from the app, or one of the eight recovery codes (`abcd-efgh`); a person may type capitals and spaces. */
const CODE_SHAPE = /^(\d{6}|[a-z0-9]{4}-[a-z0-9]{4})$/;

function normalizeCode(text: string): string {
  return text.trim().toLowerCase();
}

/** Builds the request the API expects; an empty code is left out instead of being sent. */
export function toLoginRequest(values: LoginFormValues): LoginRequest {
  const totp = normalizeCode(values.totp);
  return loginRequestSchema.parse({
    username: values.username.trim(),
    password: values.password,
    ...(totp === '' ? {} : { totp }),
  });
}

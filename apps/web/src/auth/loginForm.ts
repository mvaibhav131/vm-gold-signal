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
  if (values.totp !== '' && !/^\d{6}$/.test(values.totp)) errors.totp = 'The code has 6 digits';
  return errors;
}

/** Builds the request the API expects; an empty code is left out instead of being sent. */
export function toLoginRequest(values: LoginFormValues): LoginRequest {
  return loginRequestSchema.parse({
    username: values.username.trim(),
    password: values.password,
    ...(values.totp === '' ? {} : { totp: values.totp }),
  });
}

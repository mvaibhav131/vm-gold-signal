import { passwordChangeRequestSchema, type PasswordChangeRequest } from '@vmgs/contracts';

export interface PasswordFormValues {
  current: string;
  next: string;
  confirm: string;
}

export const emptyPasswordForm: PasswordFormValues = { current: '', next: '', confirm: '' };

/** The shortest password the API accepts (`passwordChangeRequestSchema`). */
export const MIN_PASSWORD_LENGTH = 12;

export function validatePasswordForm(
  values: PasswordFormValues,
): Partial<Record<keyof PasswordFormValues, string>> {
  const errors: Partial<Record<keyof PasswordFormValues, string>> = {};
  if (values.current === '') errors.current = 'Enter your current password';
  if (values.next.length < MIN_PASSWORD_LENGTH) {
    errors.next = `Use at least ${String(MIN_PASSWORD_LENGTH)} characters`;
  } else if (values.next === values.current) {
    errors.next = 'The new password must be different from the current one';
  }
  if (values.confirm !== values.next) errors.confirm = 'The two passwords are not the same';
  return errors;
}

export function toPasswordRequest(values: PasswordFormValues): PasswordChangeRequest {
  return passwordChangeRequestSchema.parse({ current: values.current, next: values.next });
}

/** The code of the authenticator app: six digits. */
export function validateCode(code: string): string | null {
  return /^\d{6}$/.test(code) ? null : 'The code has 6 digits';
}

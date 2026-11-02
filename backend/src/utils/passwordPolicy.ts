import { z } from 'zod';
import { ValidationError } from './errors';

/**
 * Shared new-password policy (S-L15): length-only minimums admit `password`,
 * `11111111`, etc. New/changed passwords require 10+ chars with at least one
 * letter and one digit. Existing passwords are unaffected (login keeps the
 * legacy floor so current users are not locked out).
 */
export const newPasswordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(128)
  .regex(
    /^(?=.*[A-Za-z])(?=.*\d).+$/,
    'Password must contain at least one letter and one digit'
  );

export function assertPasswordPolicy(password: string): void {
  const parsed = newPasswordSchema.safeParse(password);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.errors.map((e) => e.message).join('; '));
  }
}

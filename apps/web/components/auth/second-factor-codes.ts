/** Shapes of a TOTP code (six digits) and of a recovery code in display form, as the API contract accepts them. */
export const TOTP_CODE = /^\d{6}$/;
export const RECOVERY_CODE = /^[A-Za-z0-9 -]{16,24}$/;

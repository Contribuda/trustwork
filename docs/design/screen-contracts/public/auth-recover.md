# Password recovery: request and reset

Routes: `/recover` (request), `/recover/[token]` (reset).

## Status and evidence

`no reference`. Spec R01 ("Authentication recovery/email rebinding must prove ownership; corporate mailbox access is not assumed to survive departure"), R21 (recovery), journey 6 (rebind login only with secure recovery), O10. Uses the [login](auth-login.md) AuthShell.

## Audience and access policy

Anonymous. The request form always responds with the same neutral confirmation regardless of whether the email exists. Reset tokens are single-use and time-limited; the reset page validates the token server-side before rendering the form. An authenticated user changes password in settings, not here. Email rebinding (changing the login email after losing access to a corporate mailbox) is a separate, stricter flow owned by BE-000 and is only linked from here ("No access to the mailbox?").

## Data projection

Request: email, prefilled from a failed login attempt or the "Forgot your password?" (`auth.forgot`) link when available (WCAG 2.2 3.3.7). Reset: new password, confirmation (optional; propose single field with show toggle). Token state: valid / expired / used / invalid.

## Primary tasks

1. Request a recovery email.
2. Set a new password from the emailed link.
3. Find the path for lost mailbox access.

## Layout regions

AuthShell at all widths (see login). Request form: H1 "Password recovery", explanation, email, "Send the link", "Back to sign-in", secondary link "No access to the mailbox?". Confirmation screen replaces the form: "If this email is registered, we have sent a message", resend after cooldown. Reset form: H1 "New password", password field with hint, "Save the password". Success: "Password changed" + "Sign in" (`auth.submitLogin`).

## Component inventory

AuthShell, TextField, PasswordField, Button, FormAlert, InlineError, Link, StatusCard (token invalid/expired).

## Interaction states

| State | Behaviour |
|---|---|
| Empty | Form |
| Loading | Spinner in button |
| Error (validation) | Field errors |
| Error (token expired/used/invalid) | StatusCard with explanation and "Request a new link"; no form |
| Error (rate limit) | Alert with retry-after |
| Permission-denied | Not applicable |
| Offline | Alert |
| Partial/stale | After success all other sessions may be revoked per policy; show note "Other sessions ended" if policy does so |

## Keyboard order and focus

Brand → back link → email → submit → links. After submit, focus moves to confirmation heading. Reset: password → toggle → submit; on success focus "Sign in" (`auth.submitLogin`) button.

## Responsive table behaviour

No tables.

## Locale keys

| Key | English |
|---|---|
| `auth.recover.title` | Password recovery |
| `auth.recover.body` | Enter the email you sign in with. We will send a link to change the password. |
| `auth.recover.submit` | Send the link |
| `auth.recover.sent` | If this email is registered, we sent a message. Check the spam folder. |
| `auth.recover.resend` | Send again |
| `auth.recover.backToLogin` | Back to sign-in |
| `auth.recover.noMailbox` | No access to the mailbox? |
| `auth.reset.title` | New password |
| `auth.reset.submit` | Save the password |
| `auth.reset.success` | Password changed |
| `auth.reset.otherSessions` | Other sessions ended |
| `auth.reset.tokenExpired` | The link has expired. Request a new one. |
| `auth.reset.tokenUsed` | This link has already been used. |
| `auth.reset.tokenInvalid` | The link is invalid. |
| `auth.reset.requestNew` | Request a new link |

## Open questions

- Email rebinding UX for departed employees (O04/O10): identity proof method not decided; only the entry link is contracted.
- Token lifetime and whether reset invalidates other sessions (BE-000).

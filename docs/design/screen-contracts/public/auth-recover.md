# Password recovery: request and reset

Routes: `/recover` (request), `/recover/[token]` (reset).

## Status and evidence

`no reference`. Spec R01 ("Authentication recovery/email rebinding must prove ownership; corporate mailbox access is not assumed to survive departure"), R21 (recovery), journey 6 (rebind login only with secure recovery), O10. Uses the [login](auth-login.md) AuthShell.

## Audience and access policy

Anonymous. The request form always responds with the same neutral confirmation regardless of whether the email exists. Reset tokens are single-use and time-limited; the reset page validates the token server-side before rendering the form. An authenticated user changes password in settings, not here. Email rebinding (changing the login email after losing access to a corporate mailbox) is a separate, stricter flow owned by BE-000 and is only linked from here («Нет доступа к почте?»).

## Data projection

Request: email, prefilled from a failed login attempt or the «Забыли пароль?» link when available (WCAG 2.2 3.3.7). Reset: new password, confirmation (optional; propose single field with show toggle). Token state: valid / expired / used / invalid.

## Primary tasks

1. Request a recovery email.
2. Set a new password from the emailed link.
3. Find the path for lost mailbox access.

## Layout regions

AuthShell at all widths (see login). Request form: H1 «Восстановление пароля», explanation, email, «Отправить ссылку», «Вернуться ко входу», secondary link «Нет доступа к почте?». Confirmation screen replaces the form: «Если такая почта зарегистрирована, мы отправили письмо», resend after cooldown. Reset form: H1 «Новый пароль», password field with hint, «Сохранить пароль». Success: «Пароль изменён» + «Войти».

## Component inventory

AuthShell, TextField, PasswordField, Button, FormAlert, InlineError, Link, StatusCard (token invalid/expired).

## Interaction states

| State | Behaviour |
|---|---|
| Empty | Form |
| Loading | Spinner in button |
| Error (validation) | Field errors |
| Error (token expired/used/invalid) | StatusCard with explanation and «Запросить новую ссылку»; no form |
| Error (rate limit) | Alert with retry-after |
| Permission-denied | Not applicable |
| Offline | Alert |
| Partial/stale | After success all other sessions may be revoked per policy; show note «Другие сессии завершены» if policy does so |

## Keyboard order and focus

Brand → back link → email → submit → links. After submit, focus moves to confirmation heading. Reset: password → toggle → submit; on success focus «Войти» button.

## Responsive table behaviour

No tables.

## Locale keys

| Key | Russian |
|---|---|
| `ru.auth.recover.title` | Восстановление пароля |
| `ru.auth.recover.body` | Укажите почту, с которой вы входите. Мы отправим ссылку для смены пароля. |
| `ru.auth.recover.submit` | Отправить ссылку |
| `ru.auth.recover.sent` | Если такая почта зарегистрирована, мы отправили письмо. Проверьте папку «Спам». |
| `ru.auth.recover.resend` | Отправить ещё раз |
| `ru.auth.recover.backToLogin` | Вернуться ко входу |
| `ru.auth.recover.noMailbox` | Нет доступа к почте? |
| `ru.auth.reset.title` | Новый пароль |
| `ru.auth.reset.submit` | Сохранить пароль |
| `ru.auth.reset.success` | Пароль изменён |
| `ru.auth.reset.otherSessions` | Другие сессии завершены |
| `ru.auth.reset.tokenExpired` | Ссылка устарела. Запросите новую. |
| `ru.auth.reset.tokenUsed` | Эта ссылка уже использована. |
| `ru.auth.reset.tokenInvalid` | Ссылка недействительна. |
| `ru.auth.reset.requestNew` | Запросить новую ссылку |

## Open questions

- Email rebinding UX for departed employees (O04/O10): identity proof method not decided; only the entry link is contracted.
- Token lifetime and whether reset invalidates other sessions (BE-000).

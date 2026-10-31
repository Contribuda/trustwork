# Login

Route: `/login` (`?next=` for return path, validated as same-origin relative path).

## Status and evidence

`proposed (reference: accepted direction)` — `login-classic.png` (private design archive), manifest `accepted_direction`: "Keep email/password primary with recovery and Apple/Google alternatives; no OTP redesign." Spec R21; IA auth routes; accessibility doc (password managers/paste allowed; no memory puzzles); rejection ledger (OTP primary auth rejected). O10 (auth library, verified linking) open.

## Audience and access policy

Anonymous only. An authenticated visitor is redirected to `next` or `/app`. Rate limiting and lockout messages must not disclose whether an email exists («Неверная почта или пароль»). Apple and Google are alternatives; account linking rules belong to O10/BE-000.

## Data projection

Form fields: email, password. No remembered email prefill from other users; browser autofill allowed (`autocomplete="username"`, `autocomplete="current-password"`). Status messages: invalid credentials, too many attempts (with retry-after), provider error, session expired notice when arriving from an expired session.

## Primary tasks

1. Sign in with email and password.
2. Recover a forgotten password.
3. Sign in with Apple or Google.
4. Go to signup or back to the public site.

## Layout regions

| Width | Layout |
|---|---|
| Desktop ≥1280 | Top bar: brand (link to `/`), right «← На главную». Two columns: left visual panel (licensed image or illustration, overlay headline + subline, decorative), right form column ~480 px: H1 «Вход», subtitle, email, password (show/hide toggle), «Забыли пароль?», primary «Войти», «или» divider, two outlined provider buttons, «Ещё нет аккаунта? Зарегистрироваться». Footer links |
| Tablet | Same two columns at ≥900; below 900 visual panel becomes a short banner above the form |
| Mobile <768 | Single column: top bar, compact brand strip (no photo or 120 px banner), form full width with 16 px gutters, buttons full width, footer links wrap |

## Component inventory

AuthShell (top bar + visual panel + footer), Brand, TextField (email), PasswordField (toggle with accessible name, `aria-pressed`), Button (primary, outlined with provider icon), Divider with text, InlineError (field-level, `aria-describedby`), FormAlert (`role="alert"` summary), Link, Spinner inside button.

## Interaction states

| State | Behaviour |
|---|---|
| Empty | Fields blank; «Войти» enabled (validation on submit, not disabled button) |
| Loading | Button shows spinner + «Входим…», fields disabled, `aria-busy` on form |
| Error (validation) | Field-level messages; focus moves to first invalid field; alert summary at top for screen readers |
| Error (credentials) | FormAlert «Неверная почта или пароль»; password cleared; email kept |
| Error (rate limit) | FormAlert «Слишком много попыток. Попробуйте через {minutes} мин.» button disabled until then |
| Error (provider) | FormAlert «Не удалось войти через {provider}. Попробуйте ещё раз или используйте почту.» |
| Permission-denied | Not applicable |
| Offline | FormAlert «Нет соединения»; submit retries when online |
| Partial/stale | Session expired notice: «Сессия завершена. Войдите снова.» shown when `?reason=expired` |

## Keyboard order and focus

Brand → «На главную» → email → password → show/hide toggle → «Забыли пароль?» → «Войти» → Apple → Google → «Зарегистрироваться» → footer links. Initial focus: not auto-moved (page H1 announced); after error, first invalid field. Enter submits from any field. Show/hide toggle does not change tab order.

## Responsive table behaviour

No tables.

## Locale keys

| Key | Russian |
|---|---|
| `ru.auth.login.title` | Вход |
| `ru.auth.login.subtitle` | Рады видеть вас снова |
| `ru.auth.emailPlaceholder` | Введите почту |
| `ru.auth.passwordPlaceholder` | Введите пароль |
| `ru.auth.showPassword` | Показать пароль |
| `ru.auth.hidePassword` | Скрыть пароль |
| `ru.auth.forgot` | Забыли пароль? |
| `ru.auth.submitLogin` | Войти |
| `ru.auth.submitting` | Входим… |
| `ru.auth.or` | или |
| `auth.apple` | Continue with Apple (neutral provider behind the identity adapter, ADR-009) |
| `ru.auth.google` | Войти через Google |
| `ru.auth.noAccount` | Ещё нет аккаунта? |
| `ru.auth.register` | Зарегистрироваться |
| `ru.auth.backHome` | На главную |
| `ru.auth.error.invalidCredentials` | Неверная почта или пароль |
| `ru.auth.error.rateLimited` | Слишком много попыток. Попробуйте через {minutes} мин. |
| `ru.auth.error.provider` | Не удалось войти через {provider}. Попробуйте ещё раз или используйте почту. |
| `ru.auth.error.emailRequired` | Укажите электронную почту |
| `ru.auth.error.emailFormat` | Проверьте адрес почты |
| `ru.auth.error.passwordRequired` | Введите пароль |
| `ru.auth.sessionExpired` | Сессия завершена. Войдите снова. |
| `ru.auth.visual.loginHeadline` | Хорошие решения. Надёжные партнёры. *(wording from reference; editorial review)* |
| `ru.auth.visual.loginSub` | Находите людей и компании, делитесь опытом и работайте над проектами. |
| `ru.footer.help` | Помощь (shared; same relative position as in PublicFooter) |

Existing keys reused: `auth.email`, `auth.password`. After a failed login, «Забыли пароль?» carries the entered email to `/recover` as a prefilled value (WCAG 2.2 3.3.7).

## Open questions

- O10: provider linking, what happens when a Google email matches an existing password account.
- Visual panel imagery licensing; fallback to brand illustration.
- «Запомнить меня» checkbox: not in reference; propose none (session policy decided in BE-000).

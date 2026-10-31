# Login

Route: `/login` (`?next=` for return path, validated as same-origin relative path).

## Status and evidence

`proposed (reference: accepted direction)` — `login-classic.png` (private design archive), manifest `accepted_direction`: "Keep email/password primary with recovery and Apple/Google alternatives; no OTP redesign." Spec R21; IA auth routes; accessibility doc (password managers/paste allowed; no memory puzzles); rejection ledger (OTP primary auth rejected). O10 (auth library, verified linking) open.

## Audience and access policy

Anonymous only. An authenticated visitor is redirected to `next` or `/app`. Rate limiting and lockout messages must not disclose whether an email exists ("Wrong email or password"). Apple and Google are alternatives; account linking rules belong to O10/BE-000.

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
| Desktop ≥1280 | Top bar: brand (link to `/`), right "← Back to home". Two columns: left visual panel (licensed image or illustration, overlay headline + subline, decorative), right form column ~480 px: H1 "Sign in", subtitle, email, password (show/hide toggle), "Forgot your password?", primary "Sign in", "or" divider, two outlined provider buttons, "No account yet? Sign up". Footer links |
| Tablet | Same two columns at ≥900; below 900 visual panel becomes a short banner above the form |
| Mobile <768 | Single column: top bar, compact brand strip (no photo or 120 px banner), form full width with 16 px gutters, buttons full width, footer links wrap |

## Component inventory

AuthShell (top bar + visual panel + footer), Brand, TextField (email), PasswordField (toggle with accessible name, `aria-pressed`), Button (primary, outlined with provider icon), Divider with text, InlineError (field-level, `aria-describedby`), FormAlert (`role="alert"` summary), Link, Spinner inside button.

## Interaction states

| State | Behaviour |
|---|---|
| Empty | Fields blank; "Sign in" enabled (validation on submit, not disabled button) |
| Loading | Button shows spinner + "Signing in…", fields disabled, `aria-busy` on form |
| Error (validation) | Field-level messages; focus moves to first invalid field; alert summary at top for screen readers |
| Error (credentials) | FormAlert "Wrong email or password"; password cleared; email kept |
| Error (rate limit) | FormAlert "Too many attempts. Try again in {minutes, plural, one {# minute} other {# minutes}}." button disabled until then |
| Error (provider) | FormAlert "Could not sign in with {provider}. Try again or use your email." |
| Permission-denied | Not applicable |
| Offline | FormAlert "No connection" (`common.offline`); submit retries when online |
| Partial/stale | Session expired notice: "Your session has ended. Please sign in again." shown when `?reason=expired` |

## Keyboard order and focus

Brand → "Back to home" → email → password → show/hide toggle → "Forgot your password?" → "Sign in" → Apple → Google → "Create an account" → footer links. Initial focus: not auto-moved (page H1 announced); after error, first invalid field. Enter submits from any field. Show/hide toggle does not change tab order.

## Responsive table behaviour

No tables.

## Locale keys

| Key | English |
|---|---|
| `auth.login.title` | Sign in |
| `auth.login.subtitle` | Good to see you again |
| `auth.emailPlaceholder` | Enter your email |
| `auth.passwordPlaceholder` | Enter your password |
| `auth.showPassword` | Show password |
| `auth.hidePassword` | Hide password |
| `auth.forgot` | Forgot your password? |
| `auth.submitLogin` | Sign in |
| `auth.submitting` | Signing in… |
| `auth.or` | or |
| `auth.apple` | Continue with Apple (neutral provider behind the identity adapter, ADR-009) |
| `auth.google` | Continue with Google |
| `auth.noAccount` | No account yet? |
| `auth.register` | Create an account |
| `auth.backHome` | Back to home |
| `auth.error.invalidCredentials` | Wrong email or password |
| `auth.error.rateLimited` | Too many attempts. Try again in {minutes, plural, one {# minute} other {# minutes}}. |
| `auth.error.provider` | Could not sign in with {provider}. Try again or use your email. |
| `auth.error.emailRequired` | Enter your email |
| `auth.error.emailFormat` | Check the email address |
| `auth.error.passwordRequired` | Enter your password |
| `auth.sessionExpired` | Your session has ended. Please sign in again. |
| `auth.visual.loginHeadline` | Good decisions. Reliable partners. *(wording from reference; editorial review)* |
| `auth.visual.loginSub` | Find people and companies, share experience and work on projects together. |
| `footer.help` | Help (shared; same relative position as in PublicFooter) |

Existing keys reused: `auth.email`, `auth.password`. After a failed login, "Forgot your password?" carries the entered email to `/recover` as a prefilled value (WCAG 2.2 3.3.7).

## Open questions

- O10: provider linking, what happens when a Google email matches an existing password account.
- Visual panel imagery licensing; fallback to brand illustration.
- "Remember me" checkbox: not in reference; propose none (session policy decided in BE-000).

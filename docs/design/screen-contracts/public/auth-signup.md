# Signup

Route: `/signup`.

## Status and evidence

`proposed (reference: accepted direction)` — `signup.png` (private design archive), manifest `accepted_direction`: "One name input: use locale auth.name; screenshot label must not require surname." The screenshot label «Имя и фамилия» is **rejected**; the label is `auth.name` = «Как вас зовут». Spec R21 (one name field, email, password, terms; no compulsory surname/company details), journey 1.

## Audience and access policy

Anonymous only; authenticated redirect to `/app`. No company, INN or role questions. Terms acceptance is required and recorded with version and timestamp. Email verification policy (before or after first login) is decided in BE-000/O10; the UI must support a «Подтвердите почту» interstitial either way.

## Data projection

Fields: name (one free-text field, any script, 1–100 chars), email, password (policy: minimum length from BE-000; hint shows the policy text, not a puzzle), terms checkbox with links to terms and privacy. Password strength meter optional, never blocking beyond policy.

## Primary tasks

1. Create a personal account with one name field.
2. Continue with Apple or Google.
3. Return to login.

## Layout regions

Same as [login](auth-login.md): two columns on desktop, stacked on mobile. Form column: H1 «Регистрация», subtitle «Создайте личный аккаунт», name, email, password with hint, terms checkbox, primary «Создать аккаунт», divider, provider buttons «Продолжить с Apple» / «Продолжить с Google», «Уже есть аккаунт? Войти».

## Component inventory

AuthShell, TextField, PasswordField, Checkbox with inline links (label contains links; links are separate tab stops), Button, Divider, InlineError, FormAlert, Link.

## Interaction states

| State | Behaviour |
|---|---|
| Empty | Button enabled; validation on submit |
| Loading | «Создаём аккаунт…» spinner |
| Error (validation) | name required; email format; password policy text; terms «Нужно принять условия использования» tied to checkbox via `aria-describedby` |
| Error (email taken) | Do not reveal directly if policy forbids; propose neutral «Не удалось создать аккаунт с этой почтой. Если у вас уже есть аккаунт, войдите или восстановите пароль.» with links |
| Error (provider) | As login |
| Permission-denied | Not applicable |
| Offline | FormAlert |
| Partial/stale | Email verification pending: interstitial «Мы отправили письмо на {email}» with resend (rate-limited) and «Изменить почту»; name and email entered at signup are kept and prefilled through the verification step and first login (WCAG 2.2 3.3.7) |

## Keyboard order and focus

Brand → «На главную» → name → email → password → toggle → terms checkbox → terms link → privacy link → «Создать аккаунт» → providers → «Войти». After validation error, focus the first invalid control. Success navigates to `/onboarding` with focus on its H1.

## Responsive table behaviour

No tables.

## Locale keys

| Key | Russian |
|---|---|
| `ru.auth.signup.title` | Регистрация |
| `ru.auth.signup.subtitle` | Создайте личный аккаунт |
| `ru.auth.namePlaceholder` | Например, Анна или Анна Белова |
| `ru.auth.passwordNewPlaceholder` | Придумайте пароль |
| `ru.auth.passwordHint` | Не короче {min} символов. Можно вставить пароль из менеджера паролей. |
| `ru.auth.acceptTermsPrefix` | Принимаю |
| `ru.auth.termsLink` | условия использования |
| `ru.auth.andPrivacy` | и политику конфиденциальности |
| `ru.auth.submitSignup` | Создать аккаунт |
| `ru.auth.signingUp` | Создаём аккаунт… |
| `auth.appleContinue` | Continue with Apple (neutral provider behind the identity adapter, ADR-009) |
| `ru.auth.googleContinue` | Продолжить с Google |
| `ru.auth.haveAccount` | Уже есть аккаунт? |
| `ru.auth.error.nameRequired` | Напишите, как к вам обращаться |
| `ru.auth.error.termsRequired` | Нужно принять условия использования |
| `ru.auth.error.signupFailed` | Не удалось создать аккаунт с этой почтой. Если у вас уже есть аккаунт, войдите или восстановите пароль. |
| `ru.auth.verify.title` | Подтвердите почту |
| `ru.auth.verify.body` | Мы отправили письмо на {email}. Перейдите по ссылке из письма. |
| `ru.auth.verify.resend` | Отправить письмо ещё раз |
| `ru.auth.verify.changeEmail` | Изменить почту |
| `ru.auth.visual.signupHeadline` | Ваш опыт. Ваши возможности. *(wording from reference; editorial review)* |
| `ru.auth.visual.signupSub` | Знакомьтесь с людьми и компаниями, делитесь знаниями и создавайте проекты. |

Existing keys reused: `auth.name` (label), `auth.email`, `auth.password`.

## Open questions

- Placeholder text: the reference uses «Как вас зовут» as placeholder under a wrong label; here «Как вас зовут» becomes the visible label and the placeholder is an example (placeholder is never the only label).
- Email-exists disclosure policy (security vs usability) — BE-000.

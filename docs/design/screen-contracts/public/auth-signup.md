# Signup

Route: `/signup`.

## Status and evidence

`proposed (reference: accepted direction)` — `signup.png` (private design archive), manifest `accepted_direction`: "One name input: use locale auth.name; screenshot label must not require surname." The screenshot label "First and last name" is **rejected**; the label is `auth.name` = "Your name". Spec R21 (one name field, email, password, terms; no compulsory surname/company details), journey 1.

## Audience and access policy

Anonymous only; authenticated redirect to `/app`. No company, INN or role questions. Terms acceptance is required and recorded with version and timestamp. Email verification policy (before or after first login) is decided in BE-000/O10; the UI must support a "Confirm your email" interstitial either way.

## Data projection

Fields: name (one free-text field, any script, 1–100 chars), email, password (policy: minimum length from BE-000; hint shows the policy text, not a puzzle), terms checkbox with links to terms and privacy. Password strength meter optional, never blocking beyond policy.

## Primary tasks

1. Create a personal account with one name field.
2. Continue with Apple or Google.
3. Return to login.

## Layout regions

Same as [login](auth-login.md): two columns on desktop, stacked on mobile. Form column: H1 "Sign up", subtitle "Create a personal account", name, email, password with hint, terms checkbox, primary "Create an account", divider, provider buttons "Continue with Apple" (`auth.appleContinue`) / "Continue with Google", "Already have an account? Sign in".

## Component inventory

AuthShell, TextField, PasswordField, Checkbox with inline links (label contains links; links are separate tab stops), Button, Divider, InlineError, FormAlert, Link.

## Interaction states

| State | Behaviour |
|---|---|
| Empty | Button enabled; validation on submit |
| Loading | "Creating the account…" spinner |
| Error (validation) | name required; email format; password policy text; terms "You need to accept the terms of use" tied to checkbox via `aria-describedby` |
| Error (email taken) | Do not reveal directly if policy forbids; propose neutral "Could not create an account with this email. If you already have an account, sign in or recover the password." with links |
| Error (provider) | As login |
| Permission-denied | Not applicable |
| Offline | FormAlert |
| Partial/stale | Email verification pending: interstitial "We sent an email to {email}" with resend (rate-limited) and "Change the email"; name and email entered at signup are kept and prefilled through the verification step and first login (WCAG 2.2 3.3.7) |

## Keyboard order and focus

Brand → "Back to home" (`auth.backHome`) → name → email → password → toggle → terms checkbox → terms link → privacy link → "Create an account" → providers → "Sign in" (`auth.submitLogin`). After validation error, focus the first invalid control. Success navigates to `/onboarding` with focus on its H1.

## Responsive table behaviour

No tables.

## Locale keys

| Key | English |
|---|---|
| `auth.signup.title` | Sign up |
| `auth.signup.subtitle` | Create a personal account |
| `auth.namePlaceholder` | For example, Anna or Anna Karimova |
| `auth.passwordNewPlaceholder` | Choose a password |
| `auth.passwordHint` | At least {min} characters. You can paste a password from a password manager. |
| `auth.acceptTermsPrefix` | I accept the |
| `auth.termsLink` | terms of use |
| `auth.andPrivacy` | and the privacy policy |
| `auth.submitSignup` | Create an account |
| `auth.signingUp` | Creating the account… |
| `auth.appleContinue` | Continue with Apple (neutral provider behind the identity adapter, ADR-009) |
| `auth.googleContinue` | Continue with Google |
| `auth.haveAccount` | Already have an account? |
| `auth.error.nameRequired` | Tell us how to address you |
| `auth.error.termsRequired` | You need to accept the terms of use |
| `auth.error.signupFailed` | Could not create an account with this email. If you already have an account, sign in or recover the password. |
| `auth.verify.title` | Confirm your email |
| `auth.verify.body` | We sent an email to {email}. Follow the link in it. |
| `auth.verify.resend` | Send the email again |
| `auth.verify.changeEmail` | Change the email |
| `auth.visual.signupHeadline` | Your experience. Your opportunities. *(wording from reference; editorial review)* |
| `auth.visual.signupSub` | Meet people and companies, share knowledge and build projects. |

Existing keys reused: `auth.name` (label), `auth.email`, `auth.password`.

## Open questions

- Placeholder text: the reference uses "Your name" as placeholder under a wrong label; here "Your name" (`auth.name`) becomes the visible label and the placeholder is an example (placeholder is never the only label).
- Email-exists disclosure policy (security vs usability) — BE-000.

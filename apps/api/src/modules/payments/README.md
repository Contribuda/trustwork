# Payments (PAY-001, partial)

The HTTP service creates immutable payment instructions; provider effects run through `apps/worker/src/payments`. The default registry has no provider. No operational source binding or rail is seeded. This is not PAY-001 acceptance.

## Boundaries

- `POST /v1/payments` accepts only `agreementId` and the original order's `budgetId`. Creation checks current buyer/session/company authority, accepted agreement and quote terms, the owning source, SANC-004 and current collecting-hub/provider configuration. It reuses the order's BILL-001 transaction reservation, including its existing amount/currency and authority. No second reserve is created.
- `GET /v1/payments/:id` returns the original requester's limited summary, with current membership required for a company. It never returns private agreement halves, screening details, the connected account or provider configuration. Synthetic success is explicitly `synthetic_no_money_moves`.
- `POST /v1/payments/:id/{confirm,refund,payout,connected-account}` accepts an empty body. Each follow-up has one stable operation ID. Refund/payout use the exact original success and account; full refund and payout cannot overlap. Account verification refers to a prebound account, not caller-supplied account registration.
- Every mutation completes BE-005 in its transaction. The outbox contains only the operation ID. Restricted API/worker roles have no raw payment-table grants.

## Dispatch, evidence and recovery

A real leased job/fence/attempt marks the operation `outcome_unknown` before the provider boundary. A second transaction locks current authority through dispatch and checks elapsed session/lease expiry after all waits. A crash between transactions retains the hold and permits only lookup of the original operation. No timeout or missing lookup result proves non-payment.

The optional worker ingress (`PAYMENTS_WEBHOOK_PORT`, loopback only; deployment owns TLS/routing) accepts at most 8 KiB of raw bytes. Provider authentication precedes parsing or database receipt acceptance. The shipped empty registry rejects all senders. Immutable receipts distinguish identical delivery, reordered notices and conflicting semantic outcomes. A terminal receipt can close the original reservation after dispatch authority is revoked. Recorded terminal evidence also reconciles a REL job parked after receipt commit but before worker acknowledgement.

`payments.lookup_due` schedules bounded original-operation lookups. A phone/QR deadline never releases the BILL hold or creates a new charge. No currency conversion, reference rate, operator-held balance or ranking/reputation dependency exists.

## Unavailable owning authority

`payment_source` is owner-only and currently has no production publisher. The owning agreement/person/company stores do not expose authoritative collecting/home hubs, party countries or connected-payee-account country/reference. These facts are never inferred from a reminder's source hub, user input or deployment country. Positive tests use labelled synthetic source/rail fixtures and real agreement/order/hub/provider workflows.

Task/consultation projections, delegated participation and independently current cross-hub screening are incomplete engineering. Distinct home hubs refuse. A valid local binding with no supported configured route records `outside_platform`. Licensed providers, operational rails and legal/operator policies remain UNKNOWN. No registration, SDK, network provider call or account change is included.

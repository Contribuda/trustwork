# Worker: agent action dispatch and reconciliation (AST-001)

Runs the external effects of agent actions queued by the API ([assistant module](../../../api/src/modules/assistant/README.md)). Registered by `main.ts` only with `ASSISTANT_EFFECTS=fake`, because only fake providers exist; `TRUSTWORK_HUB_ID` scopes hub kill switches (without it every hub-scoped switch applies).

| Piece | Kind | What it does |
|---|---|---|
| `assistant.dispatch` | external job | `assistant_begin_attempt` rechecks the mandate (status, revision, expiry), the company basis, kill switches and the person's stop, the approval and the reservation, then persists the attempt (operation id, job fencing token) and commits **before** the provider call. A refused recheck revokes the action and releases its reservation without any call. The provider result is recorded by `assistant_record_outcome`, fenced by the job's token: final success settles the reservation, a final failure or a pre-effect refusal releases it, an acknowledgement leaves the action `pending` (not success), an error or timeout records `outcome_unknown` and queues a reconciliation |
| `assistant.reconcile` | transactional job | Provider lookup by the stable correlation key; the result becomes a `reconciliation` record: found final (succeeded or failed), still acknowledged or still unknown (looked up again later), or not found, which under the adapter contract proves no effect (failed, reservation released). A lookup has no effect, so a crash simply rolls back and runs again. Nothing is ever re-submitted |
| `assistant.sweep` | scheduled task | An attempt whose dispatch job no longer holds a live lease (crashed or frozen worker; REL-001 parked the job) becomes `outcome_unknown` with reason `lease_expired` and gets a reconciliation job; the reservation stays held. The parked job is closed with the reconciliation that proved its outcome |
| `recordAssistantReceipt` | function | Asynchronous provider receipts, deduplicated by provider, account and event id: a receipt for a pending action finishes it (accepted then rejected fails and releases); a receipt for an unknown outcome is reconciliation evidence |

Provider port (`providers.ts`): adapters deduplicate by the correlation key and answer authoritative lookups; an adapter that cannot must answer `unknown`, which leaves the action for a person to reconcile. `FakeEffectProvider` (`fake_orders`, `fake_payments`, `fake_channel`) scripts `succeed`, `fail`, `reject`, `acknowledge`, `timeout_after_effect`, `timeout_before_effect` and `hang_after_effect`, and counts every effect it performs.

The worker role holds no grant on the assistant tables; it reaches them only through the six worker entry points of the migration, which return the structured effect (provider, operation, payload) and never limits, conditions or budgets.

Known follow-up (BILL-001): a reservation keeps its expiry (30 days by default for agent actions); an unknown outcome that stays unresolved that long would be expired by the billing sweeper, so the sweeper should skip reservations of actions in `outcome_unknown` or `reconciling`.

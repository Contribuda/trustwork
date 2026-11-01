import type { Transaction } from '../../deps/data.js';
import type { PrivacySubject } from '../../../../../packages/contracts/src/privacy.js';
import { billingAccounts, subscriptions, priceAcceptances } from '../../../../../packages/data/src/repositories/billing.js';
import { toPriceAcceptance, toBudget, toReservation } from './billing.service.js';

/** Owning billing projection for PRV-001. Same restricted principal transaction; never an entitlement or ranking input. */
export async function exportOwnBilling(trx: Transaction, subject: PrivacySubject): Promise<unknown> {
  const each = async <T, R>(items: readonly T[], read: (item: T) => Promise<R>) => {
    const result: R[] = [];
    for (const item of items) result.push(await read(item));
    return result;
  };
  const accounts = await billingAccounts.listForParty(trx, subject);
  const budgets = await trx.selectFrom('budget').selectAll().where(subject.kind === 'person' ? 'owner_person_id' : 'owner_company_id', '=', subject.id).orderBy('id').execute();
  return {
    accounts: await each(accounts, async (account) => ({ account, subscriptions: await subscriptions.listForAccount(trx, account.id),
      acceptances: (await priceAcceptances.listForAccount(trx, account.id)).map(toPriceAcceptance) })),
    budgets: await each(budgets, async (b) => ({ budget: toBudget(b), reservations: (await trx.selectFrom('reservation').selectAll().where('budget_id', '=', b.id).orderBy('id').execute()).map(toReservation) })),
  };
}

'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ApprovalCard, Button } from '@trustwork/ui';
import type { CommandState } from '../../../_data/command-state';
import type { NavigationCopy } from '../../../_navigation/model';
import { decideInbox, reconcileInbox } from './actions';
import { readAttempt, runAttempt, type Attempt } from './attempt';
import { readReceipt, recordReceipt, receiptMatches, type FixtureReceipt } from './transaction';
import s from '../../../_navigation/navigation.module.css';

export function Decision({ copy, title, scope, requester, requestReason, digest, expiresAt, timeZone, hidden, marker, hubId, lostResponse = false, disabledReason, children }: {
  copy: NavigationCopy; title: string; scope: string; requester: string; requestReason: string; digest: string; expiresAt: string; timeZone: string;
  hidden: Record<string, string>; marker: string; hubId: string; lostResponse?: boolean; disabledReason?: string | undefined; children: ReactNode;
}) {
  const [reason, setReason] = useState('');
  const [state, setState] = useState<CommandState>({ status: 'idle' });
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [receipt, setReceipt] = useState<FixtureReceipt | null>(null);
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState(false);
  const lock = useRef(false);
  const result = useRef<HTMLDivElement>(null);
  const key = `trustwork.console.synthetic-attempt.${marker}`;
  const receiptKey = `trustwork.console.synthetic-receipt.${marker}`;
  const actor = hidden.actor ?? '';
  const requestId = hidden['f.requestId'] ?? '';
  useEffect(() => {
    try {
      const pendingAttempt = readAttempt(window.sessionStorage, key);
      setAttempt(pendingAttempt);
      const saved = readReceipt(window.sessionStorage, receiptKey);
      if (!pendingAttempt && saved && receiptMatches(saved, actor, hubId, requestId)) setReceipt(saved);
    } catch { setAttempt({ id: marker, state: 'unknown' }); }
    setReady(true);
  }, [key, marker, receiptKey, actor, hubId, requestId]);
  function data(decision?: 'approve' | 'decline') {
    const form = new FormData();
    for (const [name, value] of Object.entries(hidden)) form.set(name, value);
    form.set('reason', reason);
    if (decision) form.set('f.decision', decision);
    return form;
  }
  async function decide(decision: 'approve' | 'decline') {
    if (lock.current || pending || !ready || disabledReason || attempt || receipt || !reason.trim()) return;
    lock.current = true;
    setPending(true);
    const id = crypto.randomUUID();
    try {
      const sent = await runAttempt(window.sessionStorage, key, id, async () => {
        const form = data(decision);
        form.set('operationId', id);
        const answer = await decideInbox(form);
        if (answer.receipt) {
          const recorded = recordReceipt(window.sessionStorage, receiptKey, answer.receipt, actor, hubId, requestId);
          if (lostResponse) throw new Error('Synthetic lost response after simulated decision');
          setReceipt(recorded);
        } else setState(answer.state);
      });
      if (!sent) setAttempt(readAttempt(window.sessionStorage, key));
    } catch {
      setAttempt({ id, state: 'unknown' });
      // A failed storage write also refuses dispatch; an uncertain response is never interpreted as success.
    } finally { setPending(false); lock.current = false; requestAnimationFrame(() => result.current?.focus()); }
  }
  async function check() {
    if (lock.current) return;
    lock.current = true;
    setPending(true);
    try {
      const checked = await reconcileInbox(data());
      if (checked.state.status === 'done') {
        const recorded = readReceipt(window.sessionStorage, receiptKey);
        // Absence of a receipt is not proof of failure. Keep unknown and refuse any new submission.
        if (!recorded || !receiptMatches(recorded, actor, hubId, requestId) || recorded.operationId !== attempt?.id) return;
        setReceipt(recorded);
        window.sessionStorage.removeItem(key);
        setAttempt(null);
      } else setState(checked.state);
    } catch { /* Keep the original correlation marker and the unknown state. */ }
    finally { setPending(false); lock.current = false; requestAnimationFrame(() => result.current?.focus()); }
  }
  const simulationState = receipt ? receipt.decision.decision === 'approve' ? copy.simulatedApproved : copy.simulatedDeclined : undefined;
  const blocked = disabledReason || simulationState || (attempt ? copy.unknown : !ready || pending ? copy.pending : undefined);
  return <div className={s.record} data-testid={`decision-${hidden['f.requestId']}`}>
    <ApprovalCard title={title} scope={scope} requester={requester} reason={requestReason} digest={digest} expiresAt={expiresAt} timeZone={timeZone}
      auditNote={copy.synthetic}
      declineReason={reason} onDeclineReasonChange={setReason} pending={pending}
      approve={{ onPress: () => void decide('approve'), disabledReason: blocked || (!reason.trim() ? copy.reasonRequired : undefined) }}
      decline={{ onPress: () => void decide('decline'), disabledReason: blocked }}>
      {children}
    </ApprovalCard>
    <div ref={result} tabIndex={-1} role="status" className={s.stack}>
      {pending ? <p>{copy.pending}</p> : null}
      {lostResponse ? <p>{copy.lostResponseDemo}</p> : null}
      {simulationState ? <p data-testid="simulated-decision">{simulationState}</p> : null}
      {attempt ? <><p>{copy.unknown}</p><p>{copy.attempt}: <code>{attempt.id}</code></p><Button variant="secondary" isDisabled={pending} onPress={() => void check()}>{copy.checkResult}</Button></> : null}
      {state.status !== 'idle' ? <p>{state.message}</p> : null}
    </div>
    <p>{copy.notActivation}</p>
  </div>;
}

'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { PROVENANCE_ROLES, ProvenanceWorkspaceSchema, PublicPublicationSchema, type ProvenanceWorkspace, type ProvenanceDeclaration, type ProvenanceConsent } from '@trustwork/contracts/client';
import { t, errorMessage, formatNumber } from '@/app/_lib/i18n';
import { withBase } from '@/app/_lib/base-path';
import { newIdempotencyKey, postJson } from '@/app/_lib/api-client';
import './provenance-editor.css';

/** Form visibility is convenience only. Every command independently checks its first-party session and object authority. */
export function ProvenanceEditor({ publicationId }: { publicationId: string }) {
  const [view,setView] = useState<ProvenanceWorkspace | null>(null);
  const [draft,setDraft] = useState<ProvenanceWorkspace['draft'] | null>(null);
  const [kind,setKind] = useState<ProvenanceDeclaration['kind']>('none');
  const [roles,setRoles] = useState<ProvenanceDeclaration['roles']>([]);
  const [reason,setReason] = useState('');
  const [note,setNote] = useState('');
  const [originalId,setOriginalId] = useState('');
  const [original,setOriginal] = useState<ProvenanceDeclaration['original']>(null);
  const [channels,setChannels] = useState<ProvenanceConsent['channels']>([]);
  const [affirm,setAffirm] = useState(false);
  const [message,setMessage] = useState('');
  const [busy,setBusy] = useState(false);
  const pending = useRef<{ fingerprint: string; key: string } | null>(null);
  const load = useCallback(async () => {
    const response = await fetch(withBase(`/v1/provenance/publications/${publicationId}`),{ credentials:'same-origin',cache:'no-store' });
    if (!response.ok) throw new Error('unavailable');
    const next = ProvenanceWorkspaceSchema.parse(await response.json());
    setView(next); setDraft(next.draft); setKind(next.record?.kind ?? (next.draft.assistantAssisted ? 'ai_assisted' : 'none')); setRoles(next.record?.roles ?? []);
    setNote(next.correctionNote ?? ''); setOriginal(next.record?.original ?? null); setOriginalId(next.record?.original?.publicationId ?? '');
    setAffirm(false); setChannels([]);
  },[publicationId]);
  useEffect(() => { void load().catch(() => setMessage(t('publicationProvenance.error'))); },[load]);
  async function command(path: `/v1/${string}`, body: Record<string,unknown>) {
    if (busy) return;
    setBusy(true);setMessage('');
    const fingerprint=JSON.stringify([path,body]);
    if (pending.current && pending.current.fingerprint!==fingerprint) { setMessage(t('publicationProvenance.error'));setBusy(false);return; }
    pending.current ??= {fingerprint,key:newIdempotencyKey()};
    try {
      const result=await postJson(path,body,{idempotencyKey:pending.current.key});
      if(result.kind==='ok') { pending.current=null;await load();setMessage(t('publicationProvenance.saved')); }
      else { if(result.kind==='error' && result.status<500 && result.error.code!=='validation.idempotency_in_progress') pending.current=null;setMessage(result.kind==='error'?errorMessage(result.error.code):t('publicationProvenance.error')); }
    } catch { setMessage(t('publicationProvenance.error')); } finally { setBusy(false); }
  }
  const staff = view?.ownerKind==='editorial' ? {staff:{reason}} : {};
  const valid = !!reason.trim() && !busy;
  const dirty = !!view && !!draft && JSON.stringify(draft)!==JSON.stringify(view.draft);
  return <section className="prov-editor" aria-busy={busy}>
    <h1>{t('publicationProvenance.title')}</h1><p role="status">{message}</p>
    <button type="button" disabled={busy} onClick={() => { void load().catch(() => setMessage(t('publicationProvenance.error'))); }}>{t('publicationProvenance.refresh')}</button>
    {view && draft ? <>
      {dirty ? <p role="status">{t('publicationProvenance.unsavedDraft')}</p> : null}
      <p>{t('content.pdfVersion',{version:formatNumber(view.binding.version),language:draft.language})}</p>
      <label>{t('publicationProvenance.heading')}<input value={draft.title} onChange={e=>setDraft({...draft,title:e.target.value})}/></label>
      <label htmlFor="provenance-body">{t('publicationProvenance.body')}</label><textarea id="provenance-body" rows={10} value={draft.body} onChange={e=>setDraft({...draft,body:e.target.value})}/>
      <label htmlFor="provenance-language">{t('publicationProvenance.language')}</label><select id="provenance-language" value={draft.language} onChange={e=>setDraft({...draft,language:e.target.value})}>{['en','es','ru','uz-Latn','ka','hy','az-Latn'].map(language=><option key={language} value={language}>{new Intl.DisplayNames([language],{type:'language'}).of(language)}</option>)}</select>
      <label>{t('publicationProvenance.reason')}<input value={reason} onChange={e=>setReason(e.target.value)} maxLength={500}/></label>
      <label>{t('publicationProvenance.correctionNote')}<input value={note} onChange={e=>setNote(e.target.value)} maxLength={500}/></label>
      <div className="prov-actions">
        {view.status==='draft' ? <button disabled={!valid} onClick={()=>void command(`/v1/publications/${publicationId}/draft`,{expectedRevision:view.publicationRevision,draft,authorship:null,...staff})}>{t('publicationProvenance.saveDraft')}</button>:null}
        {['published','corrected'].includes(view.status)?<button disabled={!valid || !note.trim()} onClick={()=>void command(`/v1/provenance/publications/${publicationId}/correction-draft`,{expectedRevision:view.publicationRevision,draft,note,...staff})}>{t('publicationProvenance.prepareCorrection')}</button>:null}
      </div>
      <fieldset><legend>{t('publicationProvenance.kind')}</legend>
        <select aria-label={t('publicationProvenance.kind')} value={kind} onChange={e=>setKind(e.target.value as ProvenanceDeclaration['kind'])}>{(['none','ai_assisted','machine_translation','generated'] as const).map(k=><option key={k} value={k}>{t(`publicationProvenance.${k==='none'?'none':k==='ai_assisted'?'aiAssisted':k==='generated'?'generated':view.record?.kind==='machine_translation'&&view.record.reviewed&&view.record.exact?'machineReviewed':'machineDraft'}`)}</option>)}</select>
        {kind!=='none'?<><p>{t('publicationProvenance.declaredRoles')}</p><div className="prov-roles">{PROVENANCE_ROLES.map(role=><label key={role}><input type="checkbox" checked={roles.includes(role)} onChange={e=>setRoles(e.target.checked?[...roles,role]:roles.filter(r=>r!==role))}/>{t(`publicationProvenance.roles.${role}`)}</label>)}</div></>:null}
      </fieldset>
      {kind==='machine_translation'?<fieldset><legend>{t('publicationProvenance.originalLink')}</legend><label>{t('publicationProvenance.originalId')}<input value={originalId} onChange={e=>{setOriginalId(e.target.value);setOriginal(null);}}/></label>
        <button disabled={busy} onClick={()=>{void fetch(withBase(`/v1/publications/${encodeURIComponent(originalId)}`),{cache:'no-store'}).then(async response=>{if(!response.ok)throw new Error('unavailable');const p=PublicPublicationSchema.parse(await response.json());setOriginal({publicationId:p.id,version:p.current.version,digest:{algorithm:'trustwork-digest-1',value:p.current.contentDigest}});}).catch(()=>setMessage(t('publicationProvenance.originalUnavailable')));}}>{t('publicationProvenance.loadOriginal')}</button>
        <p>{original ? `${t('publicationProvenance.originalVersion')}: ${formatNumber(original.version)}`:t('publicationProvenance.confirmOriginal')}</p></fieldset>:null}
      <div className="prov-actions">
        <button disabled={!valid || dirty || kind==='machine_translation'&&!original} onClick={()=>void command('/v1/provenance/declarations',{declaration:{binding:view.binding,expectedRevision:view.record?.revision??0,kind,roles:kind==='none'?[]:roles,evidence:'human_declaration',original:kind==='machine_translation'?original:null,reason},...staff})}>{t('publicationProvenance.declare')}</button>
        {view.record?.kind==='machine_translation'&&view.record.original?<button disabled={!valid || dirty || !view.record.exact || view.record.reviewed || view.record.canConsentEditor} onClick={()=>void command('/v1/provenance/reviews',{review:{provenanceId:view.record!.id,binding:view.binding,original:view.record!.original,reason},...staff})}>{t('publicationProvenance.review')}</button>:null}
      </div>
      {view.record && (view.record.canConsentEditor||view.record.canConsentReviewer)?<fieldset><legend>{t('publicationProvenance.credit')}: {view.credit}</legend>
        <p>{t('publicationProvenance.consentNotice')}</p>
        {(['web','feed','pdf'] as const).map(channel=><label key={channel}><input type="checkbox" checked={channels.includes(channel)} onChange={e=>setChannels(e.target.checked?[...channels,channel]:channels.filter(c=>c!==channel))}/>{t(`publicationProvenance.${channel}`)}</label>)}
        <label><input type="checkbox" checked={affirm} onChange={e=>setAffirm(e.target.checked)}/>{t('publicationProvenance.affirmConsent')}</label>
        <button disabled={busy||!affirm||!channels.length} onClick={()=>void command('/v1/provenance/consents',{provenanceId:view.record!.id,role:view.record!.canConsentEditor?'responsible_editor':'translation_reviewer',credit:view.credit,channels,noticeVersion:'provenance.credit.v1',informedConsent:affirm})}>{t('publicationProvenance.grantConsent')}</button>
      </fieldset>:null}
      {view.consents.filter(c=>!c.revoked).map(c=><div key={c.id}><p>{c.credit} · {c.channels.map(channel=>t(`publicationProvenance.${channel}`)).join(' · ')}</p><button disabled={!valid} onClick={()=>void command('/v1/provenance/revocations',{consentId:c.id,reason})}>{t('publicationProvenance.revokeConsent')}</button></div>)}
      <div className="prov-actions">
        {view.status==='draft'?<button disabled={!valid} onClick={()=>void command(`/v1/publications/${publicationId}/submit`,{expectedRevision:view.publicationRevision,...staff})}>{t('publicationProvenance.submit')}</button>:null}
        {view.versionStatus==='draft'?<button disabled={!valid || dirty || !view.record?.exact} onClick={()=>void command(`/v1/publications/${publicationId}/${view.correctionNote?'corrections':'publish'}`,view.correctionNote?{expectedRevision:view.publicationRevision,draft:view.draft,note:view.correctionNote,reason,...staff}:{expectedRevision:view.publicationRevision,scheduledFor:null,...staff})}>{t(view.correctionNote?'publicationProvenance.releaseCorrection':'publicationProvenance.publish')}</button>:null}
      </div>
    </>:null}
  </section>;
}

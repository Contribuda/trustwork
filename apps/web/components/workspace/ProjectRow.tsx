import NextLink from 'next/link';
import { ArrowRight, Users } from 'lucide-react';
import { MediaFrame } from '@/components/ui';
import { ProjectStatusChip, regionLabel } from '@/components/public/parts';
import { projectCover } from '@/app/_lib/media';
import type { WorkspaceProjectRow } from '@/app/_lib/data';
import { shortDate, t } from '@/app/_lib/i18n';
import { typo } from '@/app/_lib/typo';
import { intlTag } from '@trustwork/ui/i18n';

/** Calendar tile for a due date: day on top, short month below. */
export function DateTile({ date, tone = 'default' }: { date: string; tone?: 'default' | 'warn' }) {
  const d = new Date(date);
  const month = new Intl.DateTimeFormat(intlTag(), { month: 'short', timeZone: 'UTC' }).format(d).replace('.', '');
  return (
    <time dateTime={date} className={`ws-date${tone === 'warn' ? ' ws-date--warn' : ''}`}>
      <strong>{d.getUTCDate()}</strong>
      {month}
    </time>
  );
}

/** One project in a workspace list: cover, name, status, role, next milestone and milestone progress. */
export function ProjectRow({ row, compact = false }: { row: WorkspaceProjectRow; compact?: boolean }) {
  const cover = projectCover(row.handle);
  const p = row.progress;
  return (
    <li className={`ws-project${compact ? ' ws-project--compact' : ''}`}>
      <NextLink href={row.href} className="ws-project__cover" tabIndex={-1} aria-hidden="true">
        <MediaFrame media={cover} ratio="4/3" radius="none" sizes="112px" />
      </NextLink>
      <div className="ws-project__body">
        <NextLink href={row.href} className="ws-project__name">
          {typo(row.name)}
        </NextLink>
        <span className="ws-row__meta">
          <ProjectStatusChip status={row.status} size="sm" />
          <span>{t(`role.${row.myRole}`)}</span>
          <span>{row.ownerKind === 'person' ? t('projectsWs.ownerPerson') : row.ownerLabel}</span>
          {!compact ? <span>{regionLabel(row.region)}</span> : null}
          {!compact ? (
            <span>
              <Users size={12} strokeWidth={2} aria-hidden="true" /> {t('projectsWs.participants.count', { count: row.participantsCount })}
            </span>
          ) : null}
        </span>
        {p.total ? (
          <span className="ws-project__progress">
            <span className={`ws-bar${p.delayed ? ' ws-bar--warn' : ''}`} style={{ ['--p' as string]: `${p.percent}%` }} aria-hidden="true">
              <span />
            </span>
            <span className="ws-note">
              {t('projectsWs.progressOf', { done: p.done, total: p.total })}
              {p.delayed ? ` · ${t('projectsWs.delayed')}` : ''}
            </span>
          </span>
        ) : null}
      </div>
      <div className="ws-project__side">
        {row.nextMilestone ? (
          <span className="ws-project__next">
            <DateTile date={row.nextMilestone.due} tone={row.nextMilestone.changed ? 'warn' : 'default'} />
            <span>
              <span className="ws-note">{t('projectsWs.nextMilestone')}</span>
              <strong>{typo(row.nextMilestone.title)}</strong>
              {row.nextMilestone.changed ? <span className="ws-note ws-note--warn">{t('milestone.changed')}</span> : null}
            </span>
          </span>
        ) : (
          <span className="ws-note">{t('projectsWs.noMilestone')}</span>
        )}
        {!compact ? (
          <span className="ws-note">
            {t('common.updated', { date: shortDate(row.updatedAt) })} · {row.isPublished ? t('lifecycle.published') : t('projectsWs.notPublished')}
          </span>
        ) : null}
        <NextLink href={row.href} className="ws-row__action">
          {t('projectsWs.open')}
          <ArrowRight size={14} strokeWidth={2} aria-hidden="true" />
        </NextLink>
      </div>
    </li>
  );
}

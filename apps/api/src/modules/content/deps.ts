/**
 * Relative re-exports of the content slice (CNT-001). The module imports its repository directly so the shared
 * package entry (`packages/data/src/index.ts`) stays untouched; adding it to that barrel is integrator bookkeeping.
 */
export {
  comments, contentModeration, digests, issues, publicContent, publications, walls,
  type AuthorshipInput, type ContentStaffContext, type CorrectionRow, type DraftInput, type EditionLinkRow, type IssueRevisionRow, type IssueRow, type MagazineDigestRow,
  type PublicationRow, type PublicationVersionRow, type RenderArtifactRow,
} from '../../../../../packages/data/src/repositories/content.js';

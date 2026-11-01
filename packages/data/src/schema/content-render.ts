import { columnsOf, type GeneratedTimestamp, type TableColumns } from './index.js';
export interface ContentRenderDatabase {
  content_render_blob: {
    issue_revision_id: string;
    render_id: string;
    snapshot_digest: string;
    sha256: string;
    bytes: Buffer;
    created_at: GeneratedTimestamp;
  };
}
declare module './index.js' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- merges this module's table into Database
  interface Database extends ContentRenderDatabase {}
}
const columns = columnsOf<ContentRenderDatabase>();
export const TABLE_COLUMNS: TableColumns<ContentRenderDatabase> = {
  content_render_blob: columns('content_render_blob', ['issue_revision_id', 'render_id', 'snapshot_digest', 'sha256', 'bytes', 'created_at']),
};

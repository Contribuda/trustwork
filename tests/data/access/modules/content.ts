import type { AccessInventory } from '../inventory.js';

/** CNT-001 (packages/data/migrations/content): the runtime role reads under FORCE RLS and writes only through these commands. */
export default {
  package: 'CNT-001',
  forcedTables: [
    'publication', 'publication_version', 'publication_authorship', 'publication_editor', 'correction', 'publication_topic', 'entity_link', 'edition_link', 'wall_reference',
    'publication_comment', 'issue', 'issue_revision', 'issue_item', 'render_artifact', 'magazine_digest', 'magazine_digest_item',
  ],
  apiDefiners: [
    'content_can_view', 'content_create', 'content_save_draft', 'content_transition', 'content_publish', 'content_correct', 'content_retract', 'content_set_links',
    'content_grant_editor', 'content_revoke_editor', 'content_link_edition', 'content_review_edition', 'content_wall_add', 'content_wall_remove', 'content_comment',
    'content_apply_moderation', 'content_issue_create', 'content_issue_curate', 'content_issue_transition', 'content_issue_release', 'content_issue_correct',
    'content_render_request', 'content_render_record', 'content_digest_create', 'content_digest_release',
    'content_public_publication', 'content_public_version', 'content_public_feed', 'content_public_issue', 'content_public_archive', 'content_public_wall',
    'content_public_comments', 'content_public_digest',
  ],
  workerDefiners: ['content_publish_due'],
} satisfies AccessInventory;

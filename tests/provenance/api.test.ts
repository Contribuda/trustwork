import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from 'node:crypto';
import { withMaintenance, type Transaction } from '@trustwork/data';
import { sql } from 'kysely';
import { ProvenanceService } from '../../apps/api/src/modules/content/provenance/provenance.service.js';
import { ProvenanceDeclarationSchema } from '../../packages/contracts/src/provenance.js';
import type { RequestState } from '../../apps/api/src/common/request.js';
import { computeDigest } from "@trustwork/contracts";
import { startHarness, SKIP_REASON } from "../backend/helpers/app.js";
import { buildContentHttpWorld, ok, expectRefusal } from "../content/http.js";
import { draft } from "../content/helpers.js";
const h = await startHarness("provenance_api");
test(
  "provenance API: first-party CSRF, idempotency, scoped consent and elevated editorial authority",
  { skip: h ? false : SKIP_REASON },
  async (t) => {
    if (!h) return;
    const world = await buildContentHttpWorld(h);
    t.after(async () => {
      await world.close();
      await h.close();
    });
    const { c, w, anonymous } = world;
    const create = async (editorial = false) =>
      ok<{ publication: { id: string } }>(
        await (editorial ? c.editorA : c.writer).post("/v1/publications", {
          owner: { kind: editorial ? "editorial" : "person" },
          format: "article",
          articleFormat: "practice",
          originalLanguage: "en",
          licence: "cc_by",
          draft: draft({ assistantAssisted: true }),
          authorship: editorial
            ? [
                {
                  kind: "editorial",
                  credit: "Synthetic Editorial Office",
                  assistantAssisted: true,
                },
              ]
            : [
                {
                  kind: "person",
                  id: w.people.writer,
                  credit: "Synthetic Writer",
                  assistantAssisted: true,
                },
              ],
          ...(editorial
            ? { staff: { reason: "Synthetic editorial draft" } }
            : {}),
        }),
        201,
      ).publication.id;
    const id = await create();
    const body = {
      declaration: {
        binding: {
          publicationId: id,
          version: 1,
          digest: computeDigest({
            title: draft().title,
            body: draft().body,
            language: "en",
            sourceRefs: [],
            eventTime: null,
            correctionOf: null,
            correctionNote: null,
          }),
        },
        expectedRevision: 0,
        kind: "ai_assisted",
        roles: ["editorial_writer"],
        evidence: "human_declaration",
        original: null,
        reason: "Synthetic responsibility",
      },
    };
    await t.test(
      "unauthenticated, outsider and untrusted mass assignment refused",
      async () => {
        expectRefusal(
          await anonymous.post("/v1/provenance/declarations", body),
          401,
          "auth.session_invalid",
        );
        expectRefusal(
          await c.outsider.post("/v1/provenance/declarations", body),
          403,
          "access.forbidden",
        );
        expectRefusal(
          await c.writer.post("/v1/provenance/declarations", {
            ...body,
            autoPublish: true,
          }),
          422,
          "validation.unknown_field",
        );
      },
    );
    await t.test(
      "cross-site and missing CSRF headers cannot authorize decisions",
      async () => {
        assert.equal(
          (
            await c.writer.post("/v1/provenance/declarations", body, {
              csrf: "cross-site",
            })
          ).status,
          403,
        );
        assert.equal(
          (
            await c.writer.post("/v1/provenance/declarations", body, {
              csrf: "no-header",
            })
          ).status,
          403,
        );
      },
    );
    let recordId: string;
    await t.test(
      "declaration commits once and replay preserves its response",
      async () => {
        const first = ok<{ id: string; revision: number }>(
          await c.writer.post("/v1/provenance/declarations", body, {
            idempotencyKey: "prov-declare-once",
          }),
          201,
        );
        recordId = first.id;
        assert.equal(first.revision, 1);
        assert.deepEqual(
          ok(
            await c.writer.post("/v1/provenance/declarations", body, {
              idempotencyKey: "prov-declare-once",
            }),
            201,
          ),
          first,
        );
      },
    );
    await t.test(
      "explicit personal consent can be withdrawn, with no staff override",
      async () => {
        const consent = {
          provenanceId: recordId,
          role: "responsible_editor",
          credit: "Synthetic Writer",
          channels: ["web"],
          noticeVersion: "provenance.credit.v1",
          informedConsent: true,
        };
        expectRefusal(
          await c.editorB.post("/v1/provenance/consents", consent),
          404,
          "access.not_found",
        );
        const out = ok<{ consentId: string }>(
          await c.writer.post("/v1/provenance/consents", consent, {
            idempotencyKey: "prov-consent-once",
          }),
          201,
        );
        assert.deepEqual(
          ok(
            await c.writer.post("/v1/provenance/consents", consent, {
              idempotencyKey: "prov-consent-once",
            }),
            201,
          ),
          out,
        );
        expectRefusal(
          await c.outsider.post("/v1/provenance/revocations", {
            ...out,
            reason: "Synthetic denial",
          }),
          404,
          "access.not_found",
        );
        const revoke = ok(
          await c.writer.post(
            "/v1/provenance/revocations",
            { ...out, reason: "Synthetic withdrawal" },
            { idempotencyKey: "prov-revoke-once" },
          ),
        );
        assert.deepEqual(
          ok(
            await c.writer.post(
              "/v1/provenance/revocations",
              { ...out, reason: "Synthetic withdrawal" },
              { idempotencyKey: "prov-revoke-once" },
            ),
          ),
          revoke,
        );
      },
    );
    await t.test(
      "editorial decisions require current elevation and the owning hub permission",
      async () => {
        await world.elevate("editorA");
        const editorial = await create(true);
        const editorialBody = {
          declaration: {
            ...body.declaration,
            binding: { ...body.declaration.binding, publicationId: editorial },
          },
        };
        expectRefusal(
          await c.editorB.post("/v1/provenance/declarations", editorialBody),
          403,
          "access.forbidden",
        );
        expectRefusal(
          await c.editorB.post("/v1/provenance/declarations", {
            ...editorialBody,
            staff: { reason: "Synthetic action" },
          }),
          403,
          "access.forbidden",
        );
        await world.elevate("moderator");
        expectRefusal(
          await c.moderator.post("/v1/provenance/declarations", {
            ...editorialBody,
            staff: { reason: "Synthetic action" },
          }),
          403,
          "access.forbidden",
        );
        ok(
          await c.editorA.post("/v1/provenance/declarations", {
            ...editorialBody,
            staff: { reason: "Synthetic action" },
          }),
          201,
        );
      },
    );
    await t.test('snapshot transactions preserve immutable admission and the default refresh contract', async () => {
      const principals = world.app.services!.principals;
      const token = c.writer.sessionCookie!;
      const resolved = (await principals.resolve(token))!;
      assert.ok(resolved);
      const state: RequestState = { ...resolved, requestId: 'synthetic-principal-options', sessionTokenHash: createHash('sha256').update(token).digest('hex'), client: { ip: '127.0.0.1', ipPrefix: '127.0.0', userAgentFamily: 'test' } };
      const isolation = async (trx: Transaction) => (await sql<{ isolation: string }>`SELECT current_setting('transaction_isolation') AS isolation`.execute(trx)).rows[0]!.isolation;
      assert.equal(await principals.runAs(state, isolation, { snapshot: true, refreshStale: false }), 'repeatable read');
      const original = state.principal;
      await withMaintenance(h.db.admin, trx => trx.updateTable('person').set({ authz_epoch: resolved.principal.authzEpoch + 1 }).where('id', '=', w.people.writer).execute());
      let calls = 0;
      await assert.rejects(principals.runAs(state, async trx => { calls++; return isolation(trx); }, { snapshot: true, refreshStale: false }), { code: 'access.stale_epoch' });
      assert.equal(calls, 0, 'an admitted stale command must not enter its effect callback');
      assert.equal(state.principal, original, 'opt-out preserves the original request identity');
      assert.equal(await principals.runAs(state, isolation, { snapshot: true }), 'repeatable read', 'default refresh retains snapshot isolation');
      assert.equal(state.principal!.authzEpoch, resolved.principal.authzEpoch + 1, 'unrelated callers retain the existing default refresh');
      assert.equal(await principals.runAs(state, isolation), 'read committed', 'unrelated callers retain the default transaction isolation');
    });
    await t.test('an admitted request epoch is never silently refreshed for a provenance decision', async () => {
      const services = world.app.services!;
      const token = c.writer.sessionCookie!;
      const resolved = (await services.principals.resolve(token))!;
      assert.ok(resolved);
      const state: RequestState = { ...resolved, requestId: 'synthetic-stale-provenance', sessionTokenHash: createHash('sha256').update(token).digest('hex'), client: { ip: '127.0.0.1', ipPrefix: '127.0.0', userAgentFamily: 'test' } };
      const before = state.principal;
      await withMaintenance(h.db.admin, trx => trx.updateTable('person').set({ authz_epoch: resolved.principal.authzEpoch + 1 }).where('id', '=', w.people.writer).execute());
      const service = new ProvenanceService(services.principals, services.secondFactors);
      await assert.rejects(service.declare(state, ProvenanceDeclarationSchema.parse({ ...body.declaration, expectedRevision: 1 })), { code: 'access.stale_epoch' });
      assert.equal(state.principal, before, 'request identity and epoch must remain the original binding');
      const records = await withMaintenance(h.db.admin, trx => trx.selectFrom('provenance_record').selectAll().where('publication_id', '=', id).execute());
      assert.equal(records.length, 1, 'no declaration was reauthorized with a refreshed principal');
    });
  },
);

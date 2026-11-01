import test from "node:test";
import assert from "node:assert/strict";
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
  },
);

import {
  FakeC2paIptcAdapter,
  attachImageProvenance,
} from "../../apps/api/src/modules/content/provenance/image-adapter.js";
import type { ImageProvenanceInput } from "../../packages/contracts/src/provenance.js";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { sql } from "kysely";
import {
  bindTransaction,
  withMaintenance,
} from "@trustwork/data";
import { computeDigest } from "@trustwork/contracts";
import {
  provenance,
  type ProvenanceContext,
} from "../../packages/data/src/repositories/provenance.js";
import { publications } from "../../packages/data/src/repositories/content.js";
import type {
  ProvenanceDeclaration,
  ProvenanceConsent,
} from "../../packages/contracts/src/provenance.js";
import {
  provisionTestDatabase,
  SKIP_REASON,
} from "../data/helpers/postgres.js";
import {
  buildContentWorld,
  credit,
  draft,
  refused,
} from "../content/helpers.js";
const db = await provisionTestDatabase("provenance_db");
test(
  "PROV-001 restricted persistence, exact review and revocable credits",
  { skip: db ? false : SKIP_REASON },
  async (t) => {
    if (!db) return;
    t.after(() => db.close());
    await db.migrate();
    await db.createAppLogin();
    const w = await buildContentWorld(db.admin, db.app);
    const p = w.people;
    const as = w.act.as;
    const ctx = (key: keyof typeof p): ProvenanceContext => ({
      sessionId: w.admin.sessions[key]!,
      requestId: `prov-${randomUUID()}`,
    });
    const create = (key: keyof typeof p, language = "en") =>
      as(p[key], (trx) =>
        publications.create(trx, null, {
          hubId: w.hubId,
          owner: { kind: "person" },
          format: "article",
          articleFormat: "practice",
          language,
          licence: "cc_by",
          requiresReview: false,
          draft: draft({ language, assistantAssisted: true }),
          authorship: credit(p[key]),
        }),
      );
    const declaration = (
      id: string,
      language = "en",
      over: Partial<ProvenanceDeclaration> = {},
    ): ProvenanceDeclaration => ({
      binding: {
        publicationId: id,
        version: 1,
        digest: computeDigest({
          title: draft().title,
          body: draft().body,
          language,
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
      reason: "Synthetic responsibility acceptance",
      ...over,
    });
    type Metadata = {
      availability: string;
      machineAssisted: boolean;
      credits: Record<string, string>;
      revision: number;
      translation?: { stale: boolean };
    };
    const metadata = async (
      id: string,
      channel: "web" | "feed" | "pdf" = "web",
    ) => {
      const client = await db.app.connect();
      try {
        return (await provenance.deliveryMetadata(
          bindTransaction(client),
          w.hubId,
          id,
          1,
          channel,
        )) as Metadata | null;
      } finally {
        client.release();
      }
    };
    const pub = await create("writer");
    const input = declaration(pub.id);
    const record = await as(p.writer, (trx) =>
      provenance.declare(trx, ctx("writer"), input),
    );
    const consent: ProvenanceConsent = {
      provenanceId: record.id,
      role: "responsible_editor",
      credit: "Synthetic Writer",
      channels: ["web"],
      noticeVersion: "provenance.credit.v1",
      informedConsent: true,
    };
    await t.test(
      "actual caller responsibility, no outsider, edit-only, forged/expired session or direct writes",
      async () => {
        assert.equal(record.responsible_person_id, p.writer);
        assert.equal(record.evidence, "human_declaration");
        await refused(
          as(p.outsider, (trx) =>
            provenance.declare(trx, ctx("outsider"), {
              ...input,
              expectedRevision: 1,
            }),
          ),
          "42501",
          "content.not_authorised",
        );
        await as(p.writer, (trx) =>
          publications.grantEditor(trx, pub.id, p.coauthor, "edit"),
        );
        await refused(
          as(p.coauthor, (trx) =>
            provenance.declare(trx, ctx("coauthor"), {
              ...input,
              expectedRevision: 1,
            }),
          ),
          "42501",
          "content.not_authorised",
        );
        await refused(
          as(p.writer, (trx) =>
            provenance.declare(trx, ctx("outsider"), input),
          ),
          "42501",
          "provenance.first_party_required",
        );
        await refused(
          as(p.writer, (trx) =>
            provenance.declare(
              trx,
              { ...ctx("writer"), sessionId: randomUUID() },
              input,
            ),
          ),
          "42501",
          "provenance.first_party_required",
        );
        await refused(
          as(p.writer, (trx) =>
            sql`UPDATE trustwork.provenance_record SET kind='none' WHERE id=${record.id}::uuid`.execute(
              trx,
            ),
          ),
          "42501",
        );
        assert.deepEqual(
          await as(p.outsider, (trx) => provenance.history(trx, pub.id)),
          [],
        );
        const count = await db.app.query(
          "SELECT count(*)::int n FROM trustwork.provenance_record",
        );
        assert.equal(count.rows[0].n, 0);
      },
    );
    await t.test(
      "record is immutable even to maintenance; digest cannot be substituted or disclosure downgraded",
      async () => {
        await assert.rejects(
          withMaintenance(db.admin, (trx) =>
            sql`UPDATE trustwork.provenance_record SET reason='rewrite' WHERE id=${record.id}::uuid`.execute(
              trx,
            ),
          ),
        );
        await refused(
          as(p.writer, (trx) =>
            provenance.declare(trx, ctx("writer"), {
              ...input,
              expectedRevision: 1,
              binding: { ...input.binding, digest: computeDigest("wrong") },
            }),
          ),
          "23514",
          "provenance.binding_mismatch",
        );
        await refused(
          as(p.writer, (trx) =>
            provenance.declare(trx, ctx("writer"), {
              ...input,
              expectedRevision: 1,
              kind: "none",
              roles: [],
            }),
          ),
          "23514",
          "provenance.disclosure_required",
        );
      },
    );
    await t.test(
      "draft has no delivery metadata; publication composes the real CNT command",
      async () => {
        assert.equal(await metadata(pub.id), null);
        const result = await as(p.writer, (trx) =>
          provenance.publish(trx, ctx("writer"), record.id, pub.revision),
        );
        assert.equal(result.status, "published");
        const out = await metadata(pub.id);
        assert.equal(out?.machineAssisted, true);
        assert.deepEqual(out?.credits, {});
        assert.ok(!JSON.stringify(out).includes(p.writer));
      },
    );
    let consentId: string;
    await t.test(
      "own explicit scope only; no generic consent or other person may name the editor",
      async () => {
        await refused(
          as(p.outsider, (trx) =>
            provenance.consent(trx, ctx("outsider"), consent),
          ),
          "P0002",
          "content.not_found",
        );
        await refused(
          as(p.writer, (trx) =>
            provenance.consent(trx, ctx("writer"), {
              ...consent,
              credit: "Invented Person",
            }),
          ),
          "23514",
          "provenance.consent_required",
        );
        const row = await as(p.writer, (trx) =>
          provenance.consent(trx, ctx("writer"), consent),
        );
        consentId = row.id;
        assert.deepEqual((await metadata(pub.id))?.credits, {
          responsible_editor: "Synthetic Writer",
        });
        assert.deepEqual((await metadata(pub.id, "pdf"))?.credits, {});
        assert.deepEqual((await metadata(pub.id, "feed"))?.credits, {});
      },
    );
    await t.test(
      "revocation affects a later read in an already open READ COMMITTED transaction; label remains",
      async () => {
        const client = await db.app.connect();
        try {
          await client.query("BEGIN");
          const trx = bindTransaction(client);
          assert.equal(
            (
              (await provenance.deliveryMetadata(
                trx,
                w.hubId,
                pub.id,
                1,
                "web",
              )) as Metadata
            ).credits.responsible_editor,
            "Synthetic Writer",
          );
          await as(p.writer, (trx) =>
            provenance.revoke(
              trx,
              ctx("writer"),
              consentId,
              "Synthetic withdrawal",
            ),
          );
          const later = (await provenance.deliveryMetadata(
            trx,
            w.hubId,
            pub.id,
            1,
            "web",
          )) as Metadata;
          assert.deepEqual(later.credits, {});
          assert.equal(later.machineAssisted, true);
          await client.query("COMMIT");
        } finally {
          await client.query("ROLLBACK");
          client.release();
        }
        await refused(
          as(p.outsider, (trx) =>
            provenance.revoke(trx, ctx("outsider"), consentId, "No right"),
          ),
          "P0002",
          "content.not_found",
        );
      },
    );
    await t.test(
      "two concurrent appended corrections produce one winner and preserve frozen content",
      async () => {
        const outcomes = await Promise.allSettled(
          [1, 2].map(() =>
            as(p.writer, (trx) =>
              provenance.declare(trx, ctx("writer"), {
                ...input,
                expectedRevision: 1,
                reason: "Synthetic provenance correction",
              }),
            ),
          ),
        );
        assert.equal(
          outcomes.filter((x) => x.status === "fulfilled").length,
          1,
        );
        assert.equal(outcomes.filter((x) => x.status === "rejected").length, 1);
        assert.equal(
          (await as(p.writer, (trx) => publications.versions(trx, pub.id)))[0]
            ?.content_digest,
          input.binding.digest.value,
        );
        assert.equal(
          (await as(p.writer, (trx) => provenance.history(trx, pub.id))).length,
          2,
        );
        assert.deepEqual(
          (await metadata(pub.id))?.credits,
          {},
          "old consent never widens to a new record",
        );
      },
    );
    const translation = await create("writer", "es");
    const trInput = declaration(translation.id, "es", {
      kind: "machine_translation",
      roles: ["editorial_translator"],
      original: input.binding,
    });
    const trRecord = await as(p.writer, (trx) =>
      provenance.declare(trx, ctx("writer"), trInput),
    );
    const review = {
      provenanceId: trRecord.id,
      binding: trInput.binding,
      original: input.binding,
      reason: "Synthetic exact version review",
    };
    await t.test(
      "translation stays draft until a different authorized named reviewer approves exact versions",
      async () => {
        await refused(
          as(p.writer, (trx) =>
            provenance.publish(
              trx,
              ctx("writer"),
              trRecord.id,
              translation.revision,
            ),
          ),
          "23514",
          "provenance.review_required",
        );
        assert.equal(
          (await as(p.writer, (trx) => publications.get(trx, translation.id)))
            ?.status,
          "draft",
        );
        await refused(
          as(p.writer, (trx) => provenance.review(trx, ctx("writer"), review)),
          "42501",
          "content.self_review",
        );
        await refused(
          as(p.outsider, (trx) =>
            provenance.review(trx, ctx("outsider"), review),
          ),
          "42501",
          "content.not_authorised",
        );
        await as(p.writer, (trx) =>
          publications.grantEditor(trx, translation.id, p.coauthor, "publish"),
        );
        await refused(
          as(p.coauthor, (trx) =>
            provenance.review(trx, ctx("coauthor"), {
              ...review,
              binding: { ...review.binding, version: 2 },
            }),
          ),
          "23514",
          "provenance.binding_mismatch",
        );
        const results = await Promise.allSettled(
          [1, 2].map(() =>
            as(p.coauthor, (trx) =>
              provenance.review(trx, ctx("coauthor"), review),
            ),
          ),
        );
        assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
        await as(p.writer, (trx) =>
          provenance.publish(
            trx,
            ctx("writer"),
            trRecord.id,
            translation.revision,
          ),
        );
        assert.equal(
          (await metadata(translation.id))?.translation?.stale,
          false,
        );
        assert.deepEqual((await metadata(translation.id))?.credits, {});
      },
    );
    await t.test(
      "original correction makes the bound translation stale; retraction withholds metadata",
      async () => {
        const current = (await as(p.writer, (trx) =>
          publications.get(trx, pub.id),
        ))!;
        const corrected = await as(p.writer, (trx) =>
          publications.correct(
            trx,
            null,
            pub.id,
            current.revision,
            draft({ body: "Synthetic correction", assistantAssisted: true }),
            "Synthetic correction",
            "Synthetic evidence",
          ),
        );
        assert.equal(
          (await metadata(translation.id))?.translation?.stale,
          true,
        );
        await as(p.writer, (trx) =>
          publications.retract(
            trx,
            null,
            pub.id,
            corrected.revision,
            "Synthetic retraction",
          ),
        );
        assert.equal(await metadata(translation.id), null);
      },
    );
    await t.test(
      "draft edit invalidates an earlier review even when the version number stays the same",
      async () => {
        const original = await create("writer");
        await as(p.writer, (trx) =>
          publications.publish(trx, null, original.id, original.revision, null),
        );
        const d = await create("writer", "es");
        const i = declaration(d.id, "es", {
          kind: "machine_translation",
          roles: ["editorial_translator"],
          original: declaration(original.id).binding,
        });
        const r = await as(p.writer, (trx) =>
          provenance.declare(trx, ctx("writer"), i),
        );
        await as(p.writer, (trx) =>
          publications.grantEditor(trx, d.id, p.coauthor, "publish"),
        );
        await as(p.coauthor, (trx) =>
          provenance.review(trx, ctx("coauthor"), {
            provenanceId: r.id,
            binding: i.binding,
            original: i.original!,
            reason: "Synthetic review",
          }),
        );
        const changed = await as(p.writer, (trx) =>
          publications.saveDraft(
            trx,
            null,
            d.id,
            d.revision,
            draft({
              language: "es",
              body: "Changed translation",
              assistantAssisted: true,
            }),
            null,
          ),
        );
        await refused(
          as(p.writer, (trx) =>
            provenance.publish(trx, ctx("writer"), r.id, changed.revision),
          ),
          "23514",
          "provenance.binding_mismatch",
        );
      },
    );
    await t.test(
      "concurrent authority revocation or original correction wins before an exact review",
      async () => {
        for (const change of ["revoke", "correct"] as const) {
          const original = await create("writer");
          await as(p.writer, (trx) =>
            publications.publish(
              trx,
              null,
              original.id,
              original.revision,
              null,
            ),
          );
          const d = await create("writer", "es");
          const i = declaration(d.id, "es", {
            kind: "machine_translation",
            roles: ["editorial_translator"],
            original: declaration(original.id).binding,
          });
          const r = await as(p.writer, (trx) =>
            provenance.declare(trx, ctx("writer"), i),
          );
          await as(p.writer, (trx) =>
            publications.grantEditor(trx, d.id, p.coauthor, "publish"),
          );
          let release!: () => void;
          let locked!: () => void;
          let reviewerStarted!: () => void;
          const hold = new Promise<void>((resolve) => {
            release = resolve;
          });
          const ready = new Promise<void>((resolve) => {
            locked = resolve;
          });
          const started = new Promise<void>((resolve) => {
            reviewerStarted = resolve;
          });
          let reviewerPid = 0;
          const mutation = as(p.writer, async (trx) => {
            if (change === "revoke")
              await publications.revokeEditor(trx, d.id, p.coauthor);
            else {
              const pub = (await publications.get(trx, original.id))!;
              await publications.correct(
                trx,
                null,
                original.id,
                pub.revision,
                draft({ body: "Synthetic racing correction" }),
                "Correction",
                "Synthetic race",
              );
            }
            locked();
            await hold;
          });
          await ready;
          const attempted = as(p.coauthor, async (trx) => {
            reviewerPid = (
              await sql<{ pid: number }>`SELECT pg_backend_pid() pid`.execute(
                trx,
              )
            ).rows[0]!.pid;
            reviewerStarted();
            return provenance.review(trx, ctx("coauthor"), {
              provenanceId: r.id,
              binding: i.binding,
              original: i.original!,
              reason: "Synthetic racing review",
            });
          }).then(
            () => null,
            (error) => error as { hint: string },
          );
          try {
            await started;
            let blocked = false;
            for (let n = 0; n < 100; n++) {
              const result = await db.admin.query<{ blocked: boolean }>(
                "SELECT cardinality(pg_blocking_pids($1))>0 blocked",
                [reviewerPid],
              );
              if (result.rows[0]?.blocked) {
                blocked = true;
                break;
              }
              await new Promise((resolve) => setTimeout(resolve, 20));
            }
            assert.equal(
              blocked,
              true,
              "review actually waits on the competing publication transaction",
            );
          } finally {
            release();
          }
          await mutation;
          const error = await attempted;
          assert.equal(
            error?.hint,
            change === "revoke"
              ? "content.not_authorised"
              : "provenance.original_unavailable",
          );
          assert.equal(
            (
              await as(p.writer, (trx) =>
                trx
                  .selectFrom("provenance_review")
                  .selectAll()
                  .where("provenance_id", "=", r.id)
                  .execute(),
              )
            ).length,
            0,
          );
        }
      },
    );
    await t.test(
      "image attachment is bound to an actual clean publication artifact and remains explicitly unsigned",
      async () => {
        const pub = await create("writer");
        const i = declaration(pub.id, "en", {
          kind: "generated",
          roles: ["editorial_illustrator"],
        });
        const r = await as(p.writer, (trx) =>
          provenance.declare(trx, ctx("writer"), i),
        );
        const bytes = Buffer.from("synthetic image bytes");
        const sha = createHash("sha256").update(bytes).digest("hex");
        const asset = await withMaintenance(db.admin, (trx) =>
          trx
            .insertInto("evidence_artifact")
            .values({
              owner_person_id: p.writer,
              parent_kind: "publication",
              parent_id: pub.id,
              classification: "owner_private",
              storage_key: `synthetic/provenance/${randomUUID()}`,
              sha256: sha,
              bytes: String(bytes.length),
              media_type: "image/png",
              scan_state: "clean",
              uploaded_by: p.writer,
            })
            .returning("id")
            .executeTakeFirstOrThrow(),
        );
        const input: ImageProvenanceInput = {
          binding: i.binding,
          provenanceId: r.id,
          assetId: asset.id,
          assetSha256: sha,
          digitalSourceType: "trainedAlgorithmicMedia",
          depictsRealPerson: false,
          documentary: false,
        };
        const fake = new FakeC2paIptcAdapter();
        await assert.rejects(
          as(p.writer, (trx) =>
            attachImageProvenance(trx, ctx("writer"), bytes, input),
          ),
          /signing_authority_unavailable/,
        );
        await refused(
          as(p.outsider, (trx) =>
            attachImageProvenance(trx, ctx("outsider"), bytes, input, fake),
          ),
          "42501",
          "content.not_authorised",
        );
        await refused(
          as(p.writer, (trx) =>
            attachImageProvenance(
              trx,
              ctx("writer"),
              bytes,
              { ...input, assetId: randomUUID() },
              fake,
            ),
          ),
          "23514",
          "provenance.image_binding_mismatch",
        );
        await refused(
          as(p.writer, (trx) =>
            attachImageProvenance(
              trx,
              ctx("writer"),
              bytes,
              { ...input, binding: { ...input.binding, version: 2 } },
              fake,
            ),
          ),
          "23514",
          "provenance.image_binding_mismatch",
        );
        const id = await as(p.writer, (trx) =>
          attachImageProvenance(trx, ctx("writer"), bytes, input, fake),
        );
        const stored = await as(p.writer, (trx) =>
          trx
            .selectFrom("provenance_image_attachment")
            .selectAll()
            .where("id", "=", id)
            .executeTakeFirstOrThrow(),
        );
        assert.equal(stored.digital_source_type, "trainedAlgorithmicMedia");
        assert.equal(
          (stored.attachment as { c2paValid: boolean }).c2paValid,
          false,
        );
        await assert.rejects(
          withMaintenance(db.admin, (trx) =>
            sql`DELETE FROM trustwork.provenance_image_attachment WHERE id=${id}::uuid`.execute(
              trx,
            ),
          ),
        );
      },
    );
    await t.test(
      "audit and outbox commit with declarations and review, without public identity leakage",
      async () => {
        const counts = await withMaintenance(db.admin, async (trx) => {
          const audit = await sql<{
            n: number;
          }>`SELECT count(*)::int n FROM trustwork.audit_event WHERE action LIKE 'provenance.%'`.execute(
            trx,
          );
          const outbox = await sql<{
            n: number;
          }>`SELECT count(*)::int n FROM trustwork.outbox_event WHERE type LIKE 'provenance.%'`.execute(
            trx,
          );
          return [audit.rows[0]!.n, outbox.rows[0]!.n];
        });
        assert.equal(counts[0], counts[1]);
        assert.ok(counts[0]! >= 8);
      },
    );
  },
);

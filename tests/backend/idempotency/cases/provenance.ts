import { computeDigest } from "@trustwork/contracts";
import { withMaintenance } from "@trustwork/data";
import type { CrashCase } from "../cases.js";
import { ok } from "../../../content/http.js";

export default {
  name: "PROV-001: declarations, exact translation review and credit consent",
  async run({ h, seed, as, exactlyOnce }) {
    const hub = await withMaintenance(h.db.admin, (trx) =>
      trx
        .insertInto("hub")
        .values({ slug: `prov-${Date.now()}`, lifecycle: "public" })
        .returning("id")
        .executeTakeFirstOrThrow(),
    );
    const previous = process.env.TRUSTWORK_HUB_ID;
    process.env.TRUSTWORK_HUB_ID = hub.id;
    try {
      const writer = await as("petr");
      const reviewer = await as("xenia");
      const draft = (language: string) => ({
        title: "Synthetic provenance crash test",
        body: "Synthetic text",
        language,
        sourceRefs: [],
        treatment: "original_reporting",
        eventTime: null,
        assistantAssisted: true,
      });
      const create = async (language: string) =>
        ok<{ publication: { id: string; revision: number } }>(
          await writer.post("/v1/publications", {
            owner: { kind: "person" },
            format: "article",
            articleFormat: "practice",
            originalLanguage: language,
            licence: "cc_by",
            draft: draft(language),
            authorship: [
              {
                kind: "person",
                id: seed.people.petr,
                credit: "Synthetic Writer",
                assistantAssisted: true,
              },
            ],
          }),
          201,
        ).publication;
      const original = await create("en");
      ok(
        await writer.post(`/v1/publications/${original.id}/publish`, {
          expectedRevision: original.revision,
          scheduledFor: null,
        }),
      );
      const translation = await create("es");
      ok(
        await writer.post(`/v1/publications/${translation.id}/editors`, {
          personId: seed.people.xenia,
          rights: "publish",
        }),
      );
      const binding = (publicationId: string, language: string) => ({
        publicationId,
        version: 1,
        digest: computeDigest({
          title: draft(language).title,
          body: "Synthetic text",
          language,
          sourceRefs: [],
          eventTime: null,
          correctionOf: null,
          correctionNote: null,
        }),
      });
      const declaration = {
        binding: binding(translation.id, "es"),
        expectedRevision: 0,
        kind: "machine_translation",
        roles: ["editorial_translator"],
        evidence: "human_declaration",
        original: binding(original.id, "en"),
        reason: "Synthetic crash declaration",
      };
      const count = async (table: string, column: string, id: string) =>
        (
          await h.db.admin.query<{ n: number }>(
            `SELECT count(*)::int n FROM trustwork.${table} WHERE ${column}=$1`,
            [id],
          )
        ).rows[0]!.n;
      const record = (
        await exactlyOnce({
          action: "provenance.declare",
          client: writer,
          url: "/v1/provenance/declarations",
          body: { declaration },
          effects: () =>
            count("provenance_record", "publication_id", translation.id),
        })
      ).body as { id: string };
      await exactlyOnce({
        action: "provenance.review",
        client: reviewer,
        url: "/v1/provenance/reviews",
        body: {
          review: {
            provenanceId: record.id,
            binding: declaration.binding,
            original: declaration.original,
            reason: "Synthetic crash review",
          },
        },
        effects: () => count("provenance_review", "provenance_id", record.id),
      });
      const person = (
        await h.db.admin.query<{ display_name: string }>(
          "SELECT display_name FROM trustwork.person WHERE id=$1",
          [seed.people.petr],
        )
      ).rows[0]!;
      const consent = (
        await exactlyOnce({
          action: "provenance.consent",
          client: writer,
          url: "/v1/provenance/consents",
          body: {
            provenanceId: record.id,
            role: "responsible_editor",
            credit: person.display_name,
            channels: ["web"],
            noticeVersion: "provenance.credit.v1",
            informedConsent: true,
          },
          effects: () =>
            count("provenance_credit_consent", "provenance_id", record.id),
        })
      ).body as { consentId: string };
      await exactlyOnce({
        action: "provenance.revoke",
        client: writer,
        url: "/v1/provenance/revocations",
        body: { ...consent, reason: "Synthetic crash withdrawal" },
        effects: () =>
          count(
            "provenance_credit_revocation",
            "consent_id",
            consent.consentId,
          ),
      });
    } finally {
      if (previous === undefined) delete process.env.TRUSTWORK_HUB_ID;
      else process.env.TRUSTWORK_HUB_ID = previous;
    }
  },
} satisfies CrashCase;

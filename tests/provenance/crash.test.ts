import test from "node:test";
import assert from "node:assert/strict";
import { startHarness, SKIP_REASON } from "../backend/helpers/app.js";
import { seedPersonas, login } from "../backend/helpers/personas.js";
import {
  installCrashPoints,
  recordState,
} from "../backend/idempotency/helpers.js";
import { IDEMPOTENCY_TAKEOVER_LEASE_MS } from "../../apps/api/src/common/idempotency/index.js";
import cases from "../backend/idempotency/cases/provenance.js";
const h = await startHarness("provenance_crash");
test(
  "PROV-001 crash rollback, takeover and lost-response replay for every new route",
  { skip: h ? false : SKIP_REASON },
  async (t) => {
    if (!h) return;
    t.after(() => h.close());
    const seed = await seedPersonas(h);
    const crash = await installCrashPoints(h.db.admin);
    await cases.run({
      h,
      seed,
      as: async (key) => {
        const c = h.client();
        await login(c, key);
        return c;
      },
      exactlyOnce: async (route) => {
        const key = `crash-${route.action}`;
        const send = () =>
          route.client.post(route.url, route.body, { idempotencyKey: key });
        const before = await route.effects();
        try {
          await crash.arm("handler", "bookkeeping");
          const failed = await send();
          assert.equal(failed.status, 500, JSON.stringify(failed.body));
          assert.equal(await route.effects(), before);
          assert.equal(
            (await recordState(h.db.admin, key))?.state,
            "in_progress",
          );
          await crash.disarm("handler");
          assert.equal((await send()).status, 409);
          h.clock.advance(IDEMPOTENCY_TAKEOVER_LEASE_MS + 1000);
          const done = await send();
          assert.ok(
            done.status >= 200 && done.status < 300,
            JSON.stringify(done.body),
          );
          assert.equal(await route.effects(), before + 1);
          assert.equal(
            (await recordState(h.db.admin, key))?.state,
            "completed",
          );
          h.clock.advance(IDEMPOTENCY_TAKEOVER_LEASE_MS + 1000);
          const replay = await send();
          assert.deepEqual(replay.body, done.body);
          assert.equal(await route.effects(), before + 1);
          return done;
        } finally {
          await crash.clear();
          h.clock.reset();
        }
      },
    });
  },
);

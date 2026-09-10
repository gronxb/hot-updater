import { createDatabasePluginAdapter } from "@hot-updater/plugin-core/internal";
import { env } from "cloudflare:test";
import { expect, inject, it } from "vitest";

import { createBundleEventRowFixture } from "../../../../packages/test-utils/src/databaseTestFixtures";
import { createD1Implementation } from "../../src/d1Implementation";

it("keeps current-state reads independent of history and unrelated scopes", async () => {
  await env.DB.prepare(inject("d1Migrations")[0]!.sql).run();
  let reads = 0;
  const model = createDatabasePluginAdapter(
    "measured-d1",
    createD1Implementation({
      async query(sql, params) {
        const result = await env.DB.prepare(sql)
          .bind(...params)
          .all();
        reads += result.meta.rows_read;
        return result.results;
      },
      async batch(statements) {
        const results = await env.DB.batch(
          statements.map(({ sql, params }) =>
            env.DB.prepare(sql).bind(...params),
          ),
        );
        return results.map(({ results }) => results);
      },
    }),
  ).models.insights;
  const targets = Array.from({ length: 24 }, (_, index) => ({
    ...createBundleEventRowFixture(String(index + 1), 10_000),
    user_id: "current-user",
    to_bundle_id: "00000000-0000-7000-8000-000000009999",
  }));
  for (const event of targets) await model.recordEvent({ event });

  const measure = async () => {
    reads = 0;
    const page = await model.findLatestEvents({
      userId: "current-user",
      limit: 10,
    });
    const pageReads = reads;
    expect(page).toHaveLength(10);
    expect(page.every(({ received_at_ms }) => received_at_ms === 10_000)).toBe(
      true,
    );
    reads = 0;
    const scope = {
      platform: "ios" as const,
      channel: "production",
      sinceMs: 0,
    };
    expect(await model.countLatestEvents(scope)).toBe(24);
    const scopeReads = reads;
    reads = 0;
    expect(
      await model.countLatestEvents({
        ...scope,
        bundle: [
          {
            field: "to_bundle_id",
            value: targets[0]!.to_bundle_id,
            types: ["UPDATE_APPLIED"],
          },
        ],
      }),
    ).toBe(24);
    return { pageReads, scopeReads, bundleReads: reads };
  };
  const initial = await measure();
  expect(initial.pageReads).toBeLessThanOrEqual(22);
  expect(initial.scopeReads).toBeLessThanOrEqual(26);
  expect(initial.bundleReads).toBeLessThanOrEqual(26);

  // Late reports remain in history but cannot change the current user or scope.
  for (let sequence = 0; sequence < 100; sequence++) {
    for (const [index, current] of targets.entries()) {
      await model.recordEvent({
        event: {
          ...current,
          id: createBundleEventRowFixture(
            String(1000 + sequence * targets.length + index),
            sequence,
          ).id,
          received_at_ms: sequence,
        },
      });
    }
    if (sequence === 9) expect(await measure()).toEqual(initial);
  }
  expect(await measure()).toEqual(initial);

  for (let index = 0; index < 240; index++) {
    await model.recordEvent({
      event: {
        ...createBundleEventRowFixture(String(10_000 + index), 10_000),
        channel: "unrelated-channel",
      },
    });
  }
  const expanded = await measure();
  expect(expanded.pageReads).toBe(initial.pageReads);
  // An index range may read its first nonmatching entry at the scope boundary.
  expect(expanded.scopeReads).toBeLessThanOrEqual(initial.scopeReads + 1);
  expect(expanded.bundleReads).toBeLessThanOrEqual(initial.bundleReads + 1);
}, 60_000);

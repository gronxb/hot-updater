import { env } from "cloudflare:test";
import { expect, inject, it } from "vitest";

import {
  createBundleEventRowFixture,
  createBundleRowFixture,
  createChannelRowFixture,
  createReleaseRowFixture,
} from "../../../../packages/test-utils/src/databaseTestFixtures";
import { d1Database } from "../../src/worker";

it("reads only through declared indexes on D1, never a full scan or a sort", async () => {
  await env.DB.prepare(inject("prepareSql")).run();
  const reads: { sql: string; params: readonly unknown[] }[] = [];
  const plugin = d1Database({
    prepare(sql) {
      return {
        bind(...params) {
          if (/^\s*SELECT\b/iu.test(sql)) reads.push({ sql, params });
          return env.DB.prepare(sql).bind(...params);
        },
      };
    },
    batch: (statements) => env.DB.batch(statements as D1PreparedStatement[]),
  });

  const channel = createChannelRowFixture("production");
  const bundle = createBundleRowFixture("1");
  const release = createReleaseRowFixture("1", bundle, channel);
  await plugin.models.channels.insert({
    row: channel,
    onConflict: "returnExisting",
  });
  await plugin.commit({
    changes: [
      { model: "bundles", operation: "insert", row: bundle },
      { model: "releases", operation: "insert", row: release },
    ],
  });
  const event = createBundleEventRowFixture("11", 100);
  await plugin.models.insights.recordEvent({ event });
  await plugin.models.releases.findById(release.id);
  await plugin.models.channels.list({});
  await plugin.models.insights.findLatestEvents({
    installId: event.install_id,
  });
  await plugin.models.insights.countLatestEvents({
    platform: event.platform,
    channel: event.channel,
    sinceMs: 0,
  });

  expect(reads.length).toBeGreaterThan(5);
  for (const { sql, params } of reads) {
    const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .bind(...params)
      .all<{ detail: string }>();
    const details = plan.results.map(({ detail }) => detail);
    expect(
      details.filter((detail) => /^SCAN \S+$/u.test(detail)),
      sql,
    ).toEqual([]);
    expect(details.join("\n"), sql).not.toContain("TEMP B-TREE");
  }
});

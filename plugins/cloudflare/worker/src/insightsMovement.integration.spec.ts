import { env } from "cloudflare:test";
import { expect, inject, it } from "vitest";

import { d1Database } from "../../src/worker";

it("pages sparse movements beyond 50,000 reports through ordered native index ranges", async () => {
  await env.DB.prepare(inject("prepareSql")).run();
  await env.DB.prepare(`
    WITH RECURSIVE reports(n) AS (
      SELECT 1 UNION ALL SELECT n + 1 FROM reports WHERE n < 60000
    )
    INSERT INTO bundle_events (
      id, type, install_id, from_bundle_id, to_bundle_id, platform,
      app_version, channel, cohort, update_strategy, received_at_ms
    )
    SELECT '00000000-0000-7000-8000-' || printf('%012d', n),
      CASE n % 800 WHEN 0 THEN 'UPDATE_APPLIED' WHEN 1 THEN 'RECOVERED' ELSE 'UNCHANGED' END,
      'sparse-movement-install',
      CASE WHEN n % 800 IN (0, 1) THEN '00000000-0000-7000-8000-000000001001' ELSE NULL END,
      '00000000-0000-7000-8000-000000001002', 'ios', '1.0.0', 'production', '0',
      CASE WHEN n % 800 IN (0, 1) THEN 'appVersion' ELSE NULL END,
      n / 2
    FROM reports
  `).run();

  const queries: { sql: string; params: readonly unknown[] }[] = [];
  const plugin = d1Database({
    prepare(sql) {
      return {
        bind(...params) {
          queries.push({ sql, params });
          return env.DB.prepare(sql).bind(...params);
        },
      };
    },
    batch: () =>
      Promise.reject(new Error("Unexpected write in movement query")),
  });
  const input = {
    filter: {
      kind: "installationMovement",
      installId: "sparse-movement-install",
    },
    beforeReceivedAtMs: 30001,
    limit: 101,
  } as const;
  const first = await plugin.models.insights.listEvents(input);
  expect(first).toHaveLength(101);
  const last = first[first.length - 1]!;
  const second = await plugin.models.insights.listEvents({
    ...input,
    after: { receivedAtMs: last.received_at_ms, id: last.id },
  });
  expect(second).toHaveLength(49);
  const expected = Array.from({ length: 60000 }, (_, index) => index + 1)
    .filter((index) => index % 800 === 0 || index % 800 === 1)
    .reverse()
    .map(
      (index) => `00000000-0000-7000-8000-${String(index).padStart(12, "0")}`,
    );
  expect([...first, ...second].map(({ id }) => id)).toEqual(expected);
  expect(queries.length).toBeLessThanOrEqual(6);
  for (const { sql, params } of queries) {
    expect(sql).toContain("LIMIT");
    expect(params[params.length - 1]).toBe("0");
    const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .bind(...params)
      .all<{ detail: string }>();
    const details = plan.results.map(({ detail }) => detail).join("\n");
    expect(details).toContain("bundle_events_install_idx");
    expect(details).not.toContain("TEMP B-TREE");
  }
});

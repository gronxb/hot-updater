import { setupSemverSatisfiesTestSuite } from "@hot-updater/core/test-utils";
import { describe } from "vitest";
import { SEMVER_SATISFIES_SQL } from "./semverSatisfies";
import { env } from "cloudflare:test";

async function semverSatisfiesFromWorker(
  db: D1Database,
  version: string,
  range: string,
) {
  const sql = /* sql */ `
  WITH input AS (
    SELECT 
      ? AS app_version,
      ? AS target_app_version
  )
  SELECT ${SEMVER_SATISFIES_SQL("input")} AS version_match
  FROM input;
`;

  const result = await db.prepare(sql)
    .bind(version, range)
    .first<{ version_match: number }>();

  return Boolean(result?.version_match);
}

describe("semverSatisfies", () => {
  setupSemverSatisfiesTestSuite({
    semverSatisfies: async (version, range) =>
      semverSatisfiesFromWorker(env.DB, version, range),
  });
});

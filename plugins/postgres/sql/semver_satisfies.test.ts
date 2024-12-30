import { PGlite } from "@electric-sql/pglite";
import { setupSemverSatisfiesTestSuite } from "@hot-updater/core/test-utils";
import { afterAll, describe } from "vitest";
import { prepareSql } from "./prepareSql";

const db = new PGlite();
const sql = await prepareSql();
await db.exec(sql);

const createSemverSatisfies =
  (db: PGlite) => async (targetVersion: string, currentVersion: string) => {
    const result = await db.query<{ actual: boolean }>(`
    SELECT semver_satisfies('${targetVersion}', '${currentVersion}') AS actual;
  `);
    return result.rows[0].actual;
  };

const semverSatisfies = createSemverSatisfies(db);

describe("semverSatisfies", () => {
  afterAll(async () => {
    await db.close();
  });

  setupSemverSatisfiesTestSuite({ semverSatisfies });
});

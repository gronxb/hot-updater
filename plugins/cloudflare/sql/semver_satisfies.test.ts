import { setupSemverSatisfiesTestSuite } from "@hot-updater/core/test-utils";
import Database from "better-sqlite3";
import { afterAll, describe } from "vitest";
import { prepareSql } from "./prepareSql";

const db = new Database(":memory:");
const sql = await prepareSql();
db.exec(sql);

const createSemverSatisfies =
  (db: Database) => (targetAppVersion: string, currentVersion: string) => {
    const result = db
      .prepare(`
    SELECT semver_satisfies(?, ?) AS actual;
  `)
      .get(targetAppVersion, currentVersion) as { actual: number };
    return Boolean(result.actual);
  };

const semverSatisfies = createSemverSatisfies(db);

describe("semverSatisfies", () => {
  afterAll(() => {
    db.close();
  });

  setupSemverSatisfiesTestSuite({ semverSatisfies });
});

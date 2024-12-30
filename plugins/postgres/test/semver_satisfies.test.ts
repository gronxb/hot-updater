import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prepareSql } from "./prepareSql";

const getActual = (result: any) => {
  const actual = result.rows[0].actual;
  return actual;
};

describe("semver_satisfies", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    const sql = await prepareSql();
    await db.exec(sql);
  });

  afterAll(async () => {
    await db.close();
  });

  it("version 1.2.3 should satisfy version 1.2.3", async () => {
    const result = await db.query<{ actual: boolean }>(`
      SELECT semver_satisfies('1.2.3', '1.2.3') AS actual;
    `);

    expect(getActual(result)).toBe(true);
  });

  it("version 1.2.4 should not satisfy version 1.2.3", async () => {
    const result = await db.query<{ actual: boolean }>(`
      SELECT semver_satisfies('1.2.3', '1.2.4') AS actual;
    `);

    expect(getActual(result)).toBe(false);
  });

  it("1.x.x should satisfy version 1.0", async () => {
    const result = await db.query<{ actual: boolean }>(`
      SELECT semver_satisfies('1.x.x', '1.0') AS actual;
    `);

    expect(getActual(result)).toBe(true);
  });

  it("1.x.x should satisfy version 1.12", async () => {
    const result = await db.query<{ actual: boolean }>(`
      SELECT semver_satisfies('1.x.x', '1.12') AS actual;
    `);

    expect(getActual(result)).toBe(true);
  });

  it("1.x.x should satisfy version 1.0.0", async () => {
    const result = await db.query<{ actual: boolean }>(`
      SELECT semver_satisfies('1.x.x', '1.0.0') AS actual;
    `);

    expect(getActual(result)).toBe(true);
  });

  it("1.x.x should satisfy version 1.2.3", async () => {
    const result = await db.query<{ actual: boolean }>(`
      SELECT semver_satisfies('1.x.x', '1.2.3') AS actual;
    `);

    expect(getActual(result)).toBe(true);
  });

  it("1.x.x should not satisfy version 2.0.0", async () => {
    const result = await db.query<{ actual: boolean }>(`
      SELECT semver_satisfies('1.x.x', '2.0.0') AS actual;
    `);

    expect(getActual(result)).toBe(false);
  });

  it("1.2.x should satisfy version 1.2.5", async () => {
    const result = await db.query<{ actual: boolean }>(`
      SELECT semver_satisfies('1.2.x', '1.2.5') AS actual;
    `);

    expect(getActual(result)).toBe(true);
  });

  it("1.2.x should not satisfy version 1.3.0", async () => {
    const result = await db.query<{ actual: boolean }>(`
      SELECT semver_satisfies('1.2.x', '1.3.0') AS actual;
    `);

    expect(getActual(result)).toBe(false);
  });

  it("range 1.2.3-1.2.7 should satisfy version 1.2.5", async () => {
    const result = await db.query<{ actual: boolean }>(`
      SELECT semver_satisfies('1.2.3 - 1.2.7', '1.2.5') AS actual;
    `);

    expect(getActual(result)).toBe(true);
  });

  it("range 1.2.3-1.2.7 should not satisfy version 1.3.0", async () => {
    const result = await db.query<{ actual: boolean }>(`
      SELECT semver_satisfies('1.2.3 - 1.2.7', '1.3.0') AS actual;
    `);

    expect(getActual(result)).toBe(false);
  });

  it("range >=1.2.3 <1.2.7 should satisfy version 1.2.5", async () => {
    const result = await db.query<{ actual: boolean }>(`
      SELECT semver_satisfies('>=1.2.3 <1.2.7', '1.2.5') AS actual;
    `);

    expect(getActual(result)).toBe(true);
  });

  it("range >=1.2.3 <1.2.7 should not satisfy version 1.2.7", async () => {
    const result = await db.query<{ actual: boolean }>(`
      SELECT semver_satisfies('>=1.2.3 <1.2.7', '1.2.7') AS actual;
    `);

    expect(getActual(result)).toBe(false);
  });

  it("~1.2.3 should satisfy version 1.2.3", async () => {
    const result = await db.query<{ actual: boolean }>(`
      SELECT semver_satisfies('~1.2.3', '1.2.3') AS actual;
    `);

    expect(getActual(result)).toBe(true);
  });

  it("~1.2.3 should satisfy version 1.2.4", async () => {
    const result = await db.query<{ actual: boolean }>(`
      SELECT semver_satisfies('~1.2.3', '1.2.4') AS actual;
    `);

    expect(getActual(result)).toBe(true);
  });

  it("~1.2.3 should not satisfy version 1.3.0", async () => {
    const result = await db.query<{ actual: boolean }>(`
      SELECT semver_satisfies('~1.2.3', '1.3.0') AS actual;
    `);

    expect(getActual(result)).toBe(false);
  });

  it("^1.2.3 should satisfy version 1.3.0", async () => {
    const result = await db.query<{ actual: boolean }>(`
      SELECT semver_satisfies('^1.2.3', '1.3.0') AS actual;
    `);

    expect(getActual(result)).toBe(true);
  });

  it("^1.2.3 should not satisfy version 2.0.0", async () => {
    const result = await db.query<{ actual: boolean }>(`
      SELECT semver_satisfies('^1.2.3', '2.0.0') AS actual;
    `);

    expect(getActual(result)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import {
  isPostgresUrl,
  isVercelBlobStoreName,
  isVercelProjectName,
} from "./index";

describe("Vercel init inputs", () => {
  it("accepts project names Vercel accepts", () => {
    expect(isVercelProjectName("hot-updater")).toBe(true);
    expect(isVercelProjectName("ota.server_1")).toBe(true);
  });

  it("rejects project names Vercel rejects", () => {
    for (const name of [
      "Hot-Updater",
      "-hot-updater",
      "hot---updater",
      "hot updater",
      "a".repeat(101),
    ]) {
      expect(isVercelProjectName(name), name).toBe(false);
    }
  });

  it("checks Blob store names and PostgreSQL URLs", () => {
    expect(isVercelBlobStoreName("hot-updater-storage")).toBe(true);
    expect(isVercelBlobStoreName("a".repeat(33))).toBe(false);
    expect(isPostgresUrl("postgres://user@db.example.com/app")).toBe(true);
    expect(isPostgresUrl("postgresql://db.example.com/app")).toBe(true);
    expect(isPostgresUrl("mysql://db.example.com/app")).toBe(false);
    expect(isPostgresUrl("not a url")).toBe(false);
  });
});

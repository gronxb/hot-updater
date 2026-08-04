import fs from "node:fs/promises";

import type { TestProject } from "vitest/node";

import { prepareSql } from "./sql/prepareSql";

export default async function setup(project: TestProject) {
  const sql = await prepareSql();
  const migrationDirectory = new URL("./worker/migrations/", import.meta.url);
  const migrationFiles = (await fs.readdir(migrationDirectory))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  const migrations = await Promise.all(
    migrationFiles.map((file) =>
      fs.readFile(new URL(file, migrationDirectory), "utf8"),
    ),
  );
  project.provide("prepareSql", sql);
  project.provide("d1Migrations", migrations);
}

declare module "vitest" {
  export interface ProvidedContext {
    prepareSql: string;
    d1Migrations: readonly string[];
  }
}

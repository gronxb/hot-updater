import type { TestProject } from "vitest/node";
import { prepareSql } from "./sql/prepareSql";

export default async function setup(project: TestProject) {
  const sql = await prepareSql();
  project.provide("prepareSql", sql);
}

declare module "vitest" {
  export interface ProvidedContext {
    prepareSql: string;
  }
}

import path from "node:path";

import { describe, it } from "vitest";

import { assertProviderAnalyticsBoundary } from "./providerAnalyticsBoundary";

const workspaceRoot = path.resolve(import.meta.dirname, "../../..");
const ordinaryDatabaseProviders = [
  "aws",
  "cloudflare",
  "firebase",
  "mock",
  "postgres",
  "standalone",
  "supabase",
].map((provider) => path.join(workspaceRoot, "plugins", provider));
const serverDatabaseLayers = ["adapters", "db"].map((directory) =>
  path.join(workspaceRoot, "packages", "server", "src", directory),
);

describe("ordinary database provider architecture", () => {
  it("does not depend on Analytics imports, storage names, or capabilities", async () => {
    await assertProviderAnalyticsBoundary({
      roots: [...ordinaryDatabaseProviders, ...serverDatabaseLayers],
    });
  });
});

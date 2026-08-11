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
const managedRuntimeCompositionFiles = [
  "plugins/cloudflare/worker/src/index.ts",
  "plugins/firebase/firebase/functions/index.ts",
  "plugins/supabase/supabase/edge-functions/index.ts",
  "plugins/aws/lambda/index.ts",
  "plugins/cloudflare/package.json",
  "plugins/firebase/package.json",
  "plugins/supabase/package.json",
  "plugins/aws/package.json",
].map((file) => path.join(workspaceRoot, file));

describe("ordinary database provider architecture", () => {
  it("does not depend on Analytics or Better Auth access-key contracts", async () => {
    await assertProviderAnalyticsBoundary({
      allowedManagedPresetFiles: managedRuntimeCompositionFiles,
      roots: [...ordinaryDatabaseProviders, ...serverDatabaseLayers],
    });
  });
});

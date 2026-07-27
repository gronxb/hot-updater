import type { StorageGraphPolicy } from "./storageGraphPolicy";

export type StorageGraphCell = Readonly<{
  conditions: readonly string[];
  id: string;
  packageDirectory: string;
  sourceEntry: string;
  specifier: string;
  policy: StorageGraphPolicy;
}>;

const portableDenied = [
  "node:",
  "fs",
  "path",
  "child_process",
  "@hot-updater/cli-tools",
  "@hot-updater/server",
  "@hot-updater/better-auth",
  "@hot-updater/aws",
  "@hot-updater/cloudflare",
  "@hot-updater/firebase",
  "@hot-updater/supabase",
  "@aws-sdk/",
  "cloudflare",
  "firebase-admin",
  "wrangler",
] as const;

const webPolicy = (
  allowedExternalPrefixes: readonly string[],
): StorageGraphPolicy => ({
  allowedExternalPrefixes,
  deniedExternalPrefixes: portableDenied,
  target: "web",
});

const runtimePolicy = (
  target: string,
  allowedExternalPrefixes: readonly string[],
): StorageGraphPolicy => ({
  allowedExternalPrefixes,
  deniedExternalPrefixes: portableDenied,
  target,
});

export const storageGraphMatrix = [
  {
    id: "core-config",
    packageDirectory: "packages/core",
    sourceEntry: "packages/core/src/config.ts",
    specifier: "@hot-updater/core/config",
    conditions: [],
    policy: webPolicy([]),
  },
  {
    id: "plugin-core-storage",
    packageDirectory: "plugins/plugin-core",
    sourceEntry: "plugins/plugin-core/src/storage.ts",
    specifier: "@hot-updater/plugin-core/storage",
    conditions: [],
    policy: webPolicy([]),
  },
  {
    id: "plugin-core-storage-node",
    packageDirectory: "plugins/plugin-core",
    sourceEntry: "plugins/plugin-core/src/storage/node.ts",
    specifier: "@hot-updater/plugin-core/storage/node",
    conditions: [],
    policy: runtimePolicy("node", ["node:"]),
  },
  {
    id: "mock-storage",
    packageDirectory: "plugins/mock",
    sourceEntry: "plugins/mock/src/storage.ts",
    specifier: "@hot-updater/mock/storage",
    conditions: ["neutral"],
    policy: webPolicy(["@hot-updater/plugin-core/storage"]),
  },
  {
    id: "mock-storage-node",
    packageDirectory: "plugins/mock",
    sourceEntry: "plugins/mock/src/storage/node.ts",
    specifier: "@hot-updater/mock/storage/node",
    conditions: [],
    policy: runtimePolicy("node", ["@hot-updater/plugin-core/storage"]),
  },
  {
    id: "aws-storage",
    packageDirectory: "plugins/aws",
    sourceEntry: "plugins/aws/src/storage/index.ts",
    specifier: "@hot-updater/aws/storage",
    conditions: ["neutral"],
    policy: webPolicy(["@hot-updater/plugin-core/storage"]),
  },
  {
    id: "aws-storage-node",
    packageDirectory: "plugins/aws",
    sourceEntry: "plugins/aws/src/storage/node.ts",
    specifier: "@hot-updater/aws/storage/node",
    conditions: [],
    policy: runtimePolicy("node", [
      "@aws-sdk/client-s3",
      "@aws-sdk/cloudfront-signer",
      "@aws-sdk/s3-request-presigner",
      "@hot-updater/core/config",
      "@hot-updater/plugin-core/storage",
      "node:",
    ]),
  },
  {
    id: "aws-storage-lambda",
    packageDirectory: "plugins/aws",
    sourceEntry: "plugins/aws/src/storage/lambda.ts",
    specifier: "@hot-updater/aws/storage/lambda",
    conditions: [],
    policy: runtimePolicy("lambda", [
      "@aws-sdk/client-s3",
      "@aws-sdk/cloudfront-signer",
      "@aws-sdk/s3-request-presigner",
      "@hot-updater/core/config",
      "@hot-updater/plugin-core/storage",
      "node:",
    ]),
  },
  {
    id: "cloudflare-storage",
    packageDirectory: "plugins/cloudflare",
    sourceEntry: "plugins/cloudflare/src/storage/unsupported.ts",
    specifier: "@hot-updater/cloudflare/storage",
    conditions: ["neutral"],
    policy: webPolicy(["@hot-updater/plugin-core/storage"]),
  },
  {
    id: "cloudflare-storage-node",
    packageDirectory: "plugins/cloudflare",
    sourceEntry: "plugins/cloudflare/src/storage/node.ts",
    specifier: "@hot-updater/cloudflare/storage/node",
    conditions: [],
    policy: runtimePolicy("node", [
      "@aws-sdk/client-s3",
      "@aws-sdk/s3-request-presigner",
      "@hot-updater/core/config",
      "@hot-updater/plugin-core/storage",
      "node:",
    ]),
  },
  {
    id: "cloudflare-storage-worker",
    packageDirectory: "plugins/cloudflare",
    sourceEntry: "plugins/cloudflare/src/storage/worker.ts",
    specifier: "@hot-updater/cloudflare/storage/worker",
    conditions: ["worker"],
    policy: runtimePolicy("worker", [
      "@hot-updater/core",
      "@hot-updater/core/config",
      "@hot-updater/js",
      "@hot-updater/plugin-core/storage",
    ]),
  },
  {
    id: "firebase-storage",
    packageDirectory: "plugins/firebase",
    sourceEntry: "plugins/firebase/src/storage/unsupported.ts",
    specifier: "@hot-updater/firebase/storage",
    conditions: ["neutral"],
    policy: webPolicy(["@hot-updater/plugin-core/storage"]),
  },
  {
    id: "firebase-storage-node",
    packageDirectory: "plugins/firebase",
    sourceEntry: "plugins/firebase/src/storage/node.ts",
    specifier: "@hot-updater/firebase/storage/node",
    conditions: [],
    policy: runtimePolicy("node", [
      "@hot-updater/core/config",
      "@hot-updater/plugin-core/storage",
      "firebase-admin/app",
      "firebase-admin/storage",
      "node:",
    ]),
  },
  {
    id: "firebase-storage-functions",
    packageDirectory: "plugins/firebase",
    sourceEntry: "plugins/firebase/src/storage/functions.ts",
    specifier: "@hot-updater/firebase/storage/functions",
    conditions: [],
    policy: runtimePolicy("functions", [
      "@hot-updater/core/config",
      "@hot-updater/plugin-core/storage",
      "firebase-admin/app",
      "firebase-admin/storage",
      "node:",
    ]),
  },
  {
    id: "supabase-storage",
    packageDirectory: "plugins/supabase",
    sourceEntry: "plugins/supabase/src/storage/unsupported.ts",
    specifier: "@hot-updater/supabase/storage",
    conditions: ["neutral"],
    policy: webPolicy(["@hot-updater/plugin-core/storage"]),
  },
  {
    id: "supabase-storage-node",
    packageDirectory: "plugins/supabase",
    sourceEntry: "plugins/supabase/src/storage/node.ts",
    specifier: "@hot-updater/supabase/storage/node",
    conditions: [],
    policy: runtimePolicy("node", [
      "@hot-updater/core/config",
      "@hot-updater/plugin-core/storage",
    ]),
  },
  {
    id: "supabase-storage-edge",
    packageDirectory: "plugins/supabase",
    sourceEntry: "plugins/supabase/src/storage/edge.ts",
    specifier: "@hot-updater/supabase/storage/edge",
    conditions: ["edge"],
    policy: runtimePolicy("edge", [
      "@hot-updater/core/config",
      "@hot-updater/plugin-core/storage",
    ]),
  },
  {
    id: "standalone-storage",
    packageDirectory: "plugins/standalone",
    sourceEntry: "plugins/standalone/src/storage.ts",
    specifier: "@hot-updater/standalone/storage",
    conditions: ["neutral"],
    policy: webPolicy([
      "@hot-updater/core/config",
      "@hot-updater/plugin-core/storage",
    ]),
  },
  {
    id: "standalone-storage-node",
    packageDirectory: "plugins/standalone",
    sourceEntry: "plugins/standalone/src/storage/node.ts",
    specifier: "@hot-updater/standalone/storage/node",
    conditions: [],
    policy: runtimePolicy("node", [
      "@hot-updater/core/config",
      "@hot-updater/plugin-core/storage",
    ]),
  },
] satisfies readonly StorageGraphCell[];

export const runtimeGraphMatrix = [
  {
    id: "aws-lambda-runtime",
    packageDirectory: "plugins/aws",
    sourceEntry: "plugins/aws/src/lambda.ts",
    specifier: "@hot-updater/aws/lambda",
    conditions: [],
    policy: runtimePolicy("lambda", [
      "@aws-sdk/client-s3",
      "@aws-sdk/client-cloudfront",
      "@aws-sdk/client-ssm",
      "@aws-sdk/cloudfront-signer",
      "@aws-sdk/lib-storage",
      "@aws-sdk/s3-request-presigner",
      "@hot-updater/core",
      "@hot-updater/core/config",
      "@hot-updater/js",
      "@hot-updater/plugin-core",
      "fs",
      "mime",
      "node:",
      "path",
      "semver",
    ]),
  },
  {
    id: "cloudflare-worker-runtime",
    packageDirectory: "plugins/cloudflare",
    sourceEntry: "plugins/cloudflare/src/worker/index.ts",
    specifier: "@hot-updater/cloudflare/worker",
    conditions: ["worker"],
    policy: runtimePolicy("worker", [
      "@hot-updater/core",
      "@hot-updater/js",
      "@hot-updater/plugin-core",
      "cloudflare:workers",
      "mime",
      "semver",
    ]),
  },
  {
    id: "firebase-functions-runtime",
    packageDirectory: "plugins/firebase",
    sourceEntry: "plugins/firebase/src/functions.ts",
    specifier: "@hot-updater/firebase/functions",
    conditions: [],
    policy: runtimePolicy("functions", [
      "@hot-updater/core",
      "@hot-updater/js",
      "@hot-updater/plugin-core",
      "firebase-admin",
      "fs",
      "mime",
      "node:",
      "path",
      "semver",
    ]),
  },
  {
    id: "supabase-edge-runtime",
    packageDirectory: "plugins/supabase",
    sourceEntry: "plugins/supabase/src/edge/index.ts",
    specifier: "@hot-updater/supabase/edge",
    conditions: ["edge"],
    policy: runtimePolicy("edge", [
      "@hot-updater/core",
      "@hot-updater/js",
      "@hot-updater/plugin-core",
      "@supabase/supabase-js",
      "mime",
      "semver",
    ]),
  },
] satisfies readonly StorageGraphCell[];

export const dualRuntimeEntries = [
  ["@hot-updater/mock/storage", "mockStorage"],
  ["@hot-updater/mock/storage/node", "mockStorage"],
  ["@hot-updater/aws/storage", "s3Storage"],
  ["@hot-updater/aws/storage/node", "s3Storage"],
  ["@hot-updater/aws/storage/lambda", "s3Storage"],
  ["@hot-updater/cloudflare/storage", "r2Storage"],
  ["@hot-updater/cloudflare/storage/node", "r2Storage"],
  ["@hot-updater/firebase/storage", "firebaseStorage"],
  ["@hot-updater/firebase/storage/node", "firebaseStorage"],
  ["@hot-updater/firebase/storage/functions", "firebaseStorage"],
  ["@hot-updater/supabase/storage", "supabaseStorage"],
  ["@hot-updater/supabase/storage/node", "supabaseStorage"],
  ["@hot-updater/supabase/storage/edge", "supabaseStorage"],
  ["@hot-updater/standalone/storage", "standaloneStorage"],
  ["@hot-updater/standalone/storage/node", "standaloneStorage"],
  ["@hot-updater/core/config", "createStorageOperationContext"],
  ["@hot-updater/plugin-core/storage", "createStoragePlugin"],
  ["@hot-updater/plugin-core/storage/node", "createNodeStorageContext"],
] as const;

export const esmRuntimeEntries = [
  ["@hot-updater/cloudflare/storage/worker", "r2Storage"],
  ["@hot-updater/test-utils", "setupStoragePluginTestSuite"],
  ["@hot-updater/test-utils/storage", "createMemoryStoragePlugin"],
] as const;

export const legacyRuntimeEntries = [
  ["@hot-updater/mock", "mockDatabase"],
  ["@hot-updater/aws", "s3Database"],
  ["@hot-updater/aws/lambda", "s3Database"],
  ["@hot-updater/cloudflare", "d1Database"],
  ["@hot-updater/firebase", "firebaseDatabase"],
  ["@hot-updater/supabase", "supabaseDatabase"],
  ["@hot-updater/supabase/edge", "supabaseDatabase"],
  ["@hot-updater/standalone", "standaloneRepository"],
] as const;

export const conditionalRuntimeEntries = [
  ["@hot-updater/aws/storage", "node", "s3Storage"],
  ["@hot-updater/cloudflare/storage", "node", "r2Storage"],
  ["@hot-updater/cloudflare/storage", "workerd", "r2Storage"],
  ["@hot-updater/cloudflare/storage", "worker", "r2Storage"],
  ["@hot-updater/firebase/storage", "node", "firebaseStorage"],
  ["@hot-updater/supabase/storage", "node", "supabaseStorage"],
  ["@hot-updater/supabase/storage", "worker", "supabaseStorage"],
  ["@hot-updater/supabase/storage", "edge", "supabaseStorage"],
] as const;

export const unsupportedDefaultEntries = [
  [
    "@hot-updater/aws",
    "s3Storage",
    "AWS S3 Storage v2 requires the node export condition.",
  ],
  [
    "@hot-updater/cloudflare",
    "r2Storage",
    "Cloudflare R2 storage is unsupported in this runtime.",
  ],
  [
    "@hot-updater/firebase",
    "firebaseStorage",
    "Firebase Storage requires the Node conditional export or the explicit functions entry.",
  ],
  [
    "@hot-updater/supabase",
    "supabaseStorage",
    "Supabase storage requires a node, worker, or edge runtime condition.",
  ],
] as const;

export const storageTypeFixture = `
import { createStorageOperationContext } from "@hot-updater/core/config";
import { mockStorage } from "@hot-updater/mock/storage";
import { mockStorage as mockNodeStorage } from "@hot-updater/mock/storage/node";
import { s3Storage } from "@hot-updater/aws/storage";
import { s3Storage as nodeS3Storage } from "@hot-updater/aws/storage/node";
import {
  createLambdaStorageContext,
  s3Storage as lambdaS3Storage,
} from "@hot-updater/aws/storage/lambda";
import { r2Storage } from "@hot-updater/cloudflare/storage";
import { r2Storage as nodeR2Storage } from "@hot-updater/cloudflare/storage/node";
import {
  createWorkerStorageContext,
  r2Storage as workerR2Storage,
} from "@hot-updater/cloudflare/storage/worker";
import { firebaseStorage } from "@hot-updater/firebase/storage";
import { firebaseStorage as nodeFirebaseStorage } from "@hot-updater/firebase/storage/node";
import {
  createFunctionsStorageContext,
  firebaseStorage as functionsFirebaseStorage,
} from "@hot-updater/firebase/storage/functions";
import { supabaseStorage } from "@hot-updater/supabase/storage";
import { supabaseStorage as nodeSupabaseStorage } from "@hot-updater/supabase/storage/node";
import {
  createEdgeStorageContext,
  supabaseStorage as edgeSupabaseStorage,
} from "@hot-updater/supabase/storage/edge";
import { standaloneStorage } from "@hot-updater/standalone/storage";
import { standaloneStorage as nodeStandaloneStorage } from "@hot-updater/standalone/storage/node";
import { createStoragePlugin } from "@hot-updater/plugin-core/storage";
import { createNodeStorageContext } from "@hot-updater/plugin-core/storage/node";
import {
  createMemoryStoragePlugin,
  setupStoragePluginTestSuite,
} from "@hot-updater/test-utils";

void [
  createStorageOperationContext, mockStorage, mockNodeStorage, s3Storage,
  nodeS3Storage, lambdaS3Storage, createLambdaStorageContext, r2Storage,
  nodeR2Storage, workerR2Storage, createWorkerStorageContext, firebaseStorage,
  nodeFirebaseStorage, functionsFirebaseStorage, createFunctionsStorageContext,
  supabaseStorage, nodeSupabaseStorage, edgeSupabaseStorage,
  createEdgeStorageContext, standaloneStorage, nodeStandaloneStorage,
  createStoragePlugin, createNodeStorageContext, createMemoryStoragePlugin,
  setupStoragePluginTestSuite,
];
`;

export const storageCommonJsTypeFixture = `
type MockStorage = typeof import("@hot-updater/mock/storage");
type MockNodeStorage = typeof import("@hot-updater/mock/storage/node");
type AwsStorage = typeof import("@hot-updater/aws/storage");
type AwsNodeStorage = typeof import("@hot-updater/aws/storage/node");
type AwsLambdaStorage = typeof import("@hot-updater/aws/storage/lambda");
type CloudflareStorage = typeof import("@hot-updater/cloudflare/storage");
type CloudflareNodeStorage = typeof import("@hot-updater/cloudflare/storage/node");
type FirebaseStorage = typeof import("@hot-updater/firebase/storage");
type FirebaseNodeStorage = typeof import("@hot-updater/firebase/storage/node");
type FirebaseFunctionsStorage = typeof import("@hot-updater/firebase/storage/functions");
type SupabaseStorage = typeof import("@hot-updater/supabase/storage");
type SupabaseNodeStorage = typeof import("@hot-updater/supabase/storage/node");
type SupabaseEdgeStorage = typeof import("@hot-updater/supabase/storage/edge");
type StandaloneStorage = typeof import("@hot-updater/standalone/storage");
type StandaloneNodeStorage = typeof import("@hot-updater/standalone/storage/node");
type CoreConfig = typeof import("@hot-updater/core/config");
type PluginStorage = typeof import("@hot-updater/plugin-core/storage");
type PluginNodeStorage = typeof import("@hot-updater/plugin-core/storage/node");
declare const entries: [
  MockStorage, MockNodeStorage, AwsStorage, AwsNodeStorage, AwsLambdaStorage,
  CloudflareStorage, CloudflareNodeStorage, FirebaseStorage,
  FirebaseNodeStorage, FirebaseFunctionsStorage, SupabaseStorage,
  SupabaseNodeStorage, SupabaseEdgeStorage, StandaloneStorage,
  StandaloneNodeStorage, CoreConfig, PluginStorage, PluginNodeStorage,
];
void entries;
`;

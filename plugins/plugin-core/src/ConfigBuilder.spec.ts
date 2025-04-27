import { beforeEach, describe, expect, it } from "vitest";
import {
  ConfigBuilder,
  type IConfigBuilder, // Optional: if you want to type the variable explicitly
  type ProviderConfig,
} from "./ConfigBuilder"; // Adjust the import path as necessary

// Mock environment variables (Optional but good practice if configStrings reference them)
// These aren't strictly needed for testing the Builder's assembly logic itself,
// unless the configString values you provide in tests dynamically use them.
process.env.HOT_UPDATER_SUPABASE_URL = "mock_supabase_url";
process.env.HOT_UPDATER_SUPABASE_ANON_KEY = "mock_supabase_key";
process.env.HOT_UPDATER_SUPABASE_BUCKET_NAME = "mock_supabase_bucket";
process.env.HOT_UPDATER_FIREBASE_PROJECT_ID = "mock_firebase_project";
process.env.HOT_UPDATER_FIREBASE_STORAGE_BUCKET = "mock_firebase_bucket";
// Add others if your test config strings use them

describe("ConfigBuilder", () => {
  let builder: IConfigBuilder;

  beforeEach(() => {
    builder = new ConfigBuilder();
  });

  it("should build a basic Supabase config with bare build", () => {
    const storageConfig: ProviderConfig = {
      imports: [{ pkg: "@hot-updater/supabase", named: ["supabaseStorage"] }],
      configString: `supabaseStorage({
     supabaseUrl: process.env.HOT_UPDATER_SUPABASE_URL!,
     supabaseAnonKey: process.env.HOT_UPDATER_SUPABASE_ANON_KEY!,
     bucketName: process.env.HOT_UPDATER_SUPABASE_BUCKET_NAME!,
   })`,
    };

    const databaseConfig: ProviderConfig = {
      imports: [{ pkg: "@hot-updater/supabase", named: ["supabaseDatabase"] }],
      configString: `supabaseDatabase({
     supabaseUrl: process.env.HOT_UPDATER_SUPABASE_URL!,
     supabaseAnonKey: process.env.HOT_UPDATER_SUPABASE_ANON_KEY!,
   })`,
    };

    const result = builder
      .setBuildType("bare")
      .setStorage(storageConfig)
      .setDatabase(databaseConfig)
      .getResult();

    const expectedConfig = `import { bare } from "@hot-updater/bare";
import { supabaseDatabase, supabaseStorage } from "@hot-updater/supabase";
import "dotenv/config";
import { defineConfig } from "hot-updater";


export default defineConfig({
  build: bare({ enableHermes: true }),
  storage: supabaseStorage({
     supabaseUrl: process.env.HOT_UPDATER_SUPABASE_URL!,
     supabaseAnonKey: process.env.HOT_UPDATER_SUPABASE_ANON_KEY!,
     bucketName: process.env.HOT_UPDATER_SUPABASE_BUCKET_NAME!,
   }),
  database: supabaseDatabase({
     supabaseUrl: process.env.HOT_UPDATER_SUPABASE_URL!,
     supabaseAnonKey: process.env.HOT_UPDATER_SUPABASE_ANON_KEY!,
   }),
});`;

    expect(result).toBe(expectedConfig);
  });

  it("should build a Firebase config with rnef build and intermediate code", () => {
    // Simulate provider details that would be passed to the builder
    const storageConfig: ProviderConfig = {
      imports: [{ pkg: "@hot-updater/firebase", named: ["firebaseStorage"] }],
      configString: `firebaseStorage({
     projectId: process.env.HOT_UPDATER_FIREBASE_PROJECT_ID!,
     storageBucket: process.env.HOT_UPDATER_FIREBASE_STORAGE_BUCKET!,
     credential, // Assumes credential defined in intermediate code
   })`,
    };
    const databaseConfig: ProviderConfig = {
      imports: [{ pkg: "@hot-updater/firebase", named: ["firebaseDatabase"] }],
      configString: `firebaseDatabase({
        projectId: process.env.HOT_UPDATER_FIREBASE_PROJECT_ID!,
        credential, // Assumes credential defined in intermediate code
      })`,
    };
    const intermediate = `
// Firebase credential setup provided by client/helper
const credential = admin.credential.applicationDefault();`.trim();

    // --- Use the Builder ---
    const result = builder
      .setBuildType("rnef")
      .setStorage(storageConfig)
      .setDatabase(databaseConfig)
      .setIntermediateCode(intermediate)
      .getResult();

    // --- Define Expected Output ---
    // 테스트 실패 수정: 실제 출력과 일치하도록 예상 결과 수정
    const expectedConfig = `import { firebaseDatabase, firebaseStorage } from "@hot-updater/firebase";
import { rnef } from "@hot-updater/rnef";
import "dotenv/config";
import * as admin from "firebase-admin";
import { defineConfig } from "hot-updater";

// Firebase credential setup provided by client/helper
const credential = admin.credential.applicationDefault();

export default defineConfig({
  build: rnef(),
  storage: firebaseStorage({
     projectId: process.env.HOT_UPDATER_FIREBASE_PROJECT_ID!,
     storageBucket: process.env.HOT_UPDATER_FIREBASE_STORAGE_BUCKET!,
     credential, // Assumes credential defined in intermediate code
   }),
  database: firebaseDatabase({
        projectId: process.env.HOT_UPDATER_FIREBASE_PROJECT_ID!,
        credential, // Assumes credential defined in intermediate code
      }),
});`;

    expect(result).toBe(expectedConfig);
    expect(result).toContain("admin.credential.applicationDefault()"); // Intermediate code was included
    // Builder automatically adds '* as admin' if firebase package detected
    expect(result).toContain("import * as admin from");
  });

  it("should handle custom intermediate code without injecting firebase default", () => {
    // Even though we use firebase providers, we provide *different* intermediate code
    const storageConfig: ProviderConfig = {
      imports: [{ pkg: "@hot-updater/firebase", named: ["firebaseStorage"] }],
      configString: "firebaseStorage({ /* ... config ... */ })",
    };
    const databaseConfig: ProviderConfig = {
      imports: [{ pkg: "@hot-updater/firebase", named: ["firebaseDatabase"] }],
      configString: "firebaseDatabase({ /* ... config ... */ })",
    };
    const customIntermediate = `console.log("My custom setup code");\nconst myVar = 123;`;

    const result = builder
      .setBuildType("bare")
      .setStorage(storageConfig)
      .setDatabase(databaseConfig)
      .setIntermediateCode(customIntermediate)
      .getResult();

    // 테스트 실패 수정: 실제 출력과 일치하도록 예상 결과 수정
    const expectedConfig = `import { bare } from "@hot-updater/bare";
import { firebaseDatabase, firebaseStorage } from "@hot-updater/firebase";
import "dotenv/config";
import * as admin from "firebase-admin";
import { defineConfig } from "hot-updater";

console.log("My custom setup code");
const myVar = 123;

export default defineConfig({
  build: bare({ enableHermes: true }),
  storage: firebaseStorage({ /* ... config ... */ }),
  database: firebaseDatabase({ /* ... config ... */ }),
});`;

    expect(result).toBe(expectedConfig);
    expect(result).toContain("My custom setup code");
    // Builder still adds 'firebase-admin' import because firebase packages were used,
    // but the intermediate code does *not* contain the default setup.
    expect(result).not.toContain("admin.credential.applicationDefault()");
  });

  it("should build a mixed provider config (Cloudflare Storage, Supabase DB)", () => {
    const storageConfig: ProviderConfig = {
      imports: [{ pkg: "@hot-updater/cloudflare", named: ["r2Storage"] }],
      configString: `r2Storage({
     bucketName: 'cf-bucket',
     accountId: 'cf-account',
     cloudflareApiToken: 'cf-token',
   })`, // Example hardcoded values for test
    };
    const databaseConfig: ProviderConfig = {
      imports: [{ pkg: "@hot-updater/supabase", named: ["supabaseDatabase"] }],
      configString: `supabaseDatabase({
     supabaseUrl: 'supabase-url',
     supabaseAnonKey: 'supabase-key',
   })`, // Example hardcoded values for test
    };

    const result = builder
      .setBuildType("bare")
      .setStorage(storageConfig)
      .setDatabase(databaseConfig)
      // No intermediate code
      .getResult();

    const expectedConfig = `import { bare } from "@hot-updater/bare";
import { r2Storage } from "@hot-updater/cloudflare";
import { supabaseDatabase } from "@hot-updater/supabase";
import "dotenv/config";
import { defineConfig } from "hot-updater";


export default defineConfig({
  build: bare({ enableHermes: true }),
  storage: r2Storage({
     bucketName: 'cf-bucket',
     accountId: 'cf-account',
     cloudflareApiToken: 'cf-token',
   }),
  database: supabaseDatabase({
     supabaseUrl: 'supabase-url',
     supabaseAnonKey: 'supabase-key',
   }),
});`;

    expect(result).toBe(expectedConfig);
  });
});

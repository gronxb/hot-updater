import { describe, expect, it } from "vitest";
import { ConfigBuilder, type ProviderConfig } from "./ConfigBuilder"; // Adjust the import path as necessary

const getAwsConfigTemplate = (
  build: "bare" | "rnef",
  {
    sessionToken,
  }: {
    sessionToken?: boolean;
  },
) => {
  const storageConfig: ProviderConfig = {
    imports: [{ pkg: "@hot-updater/aws", named: ["s3Storage"] }],
    configString: "s3Storage(commonOptions)",
  };
  const databaseConfig: ProviderConfig = {
    imports: [{ pkg: "@hot-updater/aws", named: ["s3Database"] }],
    configString: `s3Database({
    ...commonOptions,
    cloudfrontDistributionId: process.env.HOT_UPDATER_CLOUDFRONT_DISTRIBUTION_ID!,
  })`,
  };

  let intermediate = "";

  if (sessionToken) {
    intermediate = `
const commonOptions = {
  bucketName: process.env.HOT_UPDATER_S3_BUCKET_NAME!,
  region: process.env.HOT_UPDATER_S3_REGION!,
  credentials: {
    accessKeyId: process.env.HOT_UPDATER_S3_ACCESS_KEY_ID!,
    secretAccessKey: process.env.HOT_UPDATER_S3_SECRET_ACCESS_KEY!,
    // This token may expire. For permanent use, it's recommended to use a key with S3FullAccess and CloudFrontFullAccess permission and remove this field.
    sessionToken: process.env.HOT_UPDATER_S3_SESSION_TOKEN!,
  },
};`.trim();
  } else {
    intermediate = `
const commonOptions = {
  bucketName: process.env.HOT_UPDATER_S3_BUCKET_NAME!,
  region: process.env.HOT_UPDATER_S3_REGION!,
  credentials: {
    accessKeyId: process.env.HOT_UPDATER_S3_ACCESS_KEY_ID!,
    secretAccessKey: process.env.HOT_UPDATER_S3_SECRET_ACCESS_KEY!,
  },
};`.trim();
  }

  return new ConfigBuilder()
    .setBuildType(build)
    .setStorage(storageConfig)
    .setDatabase(databaseConfig)
    .setIntermediateCode(intermediate)
    .getResult();
};

const getSupabaseConfigTemplate = (build: "bare" | "rnef") => {
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

  return new ConfigBuilder()
    .setBuildType(build)
    .setStorage(storageConfig)
    .setDatabase(databaseConfig)
    .getResult();
};

const getCloudflareConfigTemplate = (build: "bare" | "rnef") => {
  const storageConfig: ProviderConfig = {
    imports: [{ pkg: "@hot-updater/cloudflare", named: ["r2Storage"] }],
    configString: `r2Storage({
    bucketName: process.env.HOT_UPDATER_CLOUDFLARE_R2_BUCKET_NAME!,
    accountId: process.env.HOT_UPDATER_CLOUDFLARE_ACCOUNT_ID!,
    cloudflareApiToken: process.env.HOT_UPDATER_CLOUDFLARE_API_TOKEN!,
  })`,
  };
  const databaseConfig: ProviderConfig = {
    imports: [{ pkg: "@hot-updater/cloudflare", named: ["d1Database"] }],
    configString: `d1Database({
    databaseId: process.env.HOT_UPDATER_CLOUDFLARE_D1_DATABASE_ID!,
    accountId: process.env.HOT_UPDATER_CLOUDFLARE_ACCOUNT_ID!,
    cloudflareApiToken: process.env.HOT_UPDATER_CLOUDFLARE_API_TOKEN!,
  })`,
  };

  return new ConfigBuilder()
    .setBuildType(build)
    .setStorage(storageConfig)
    .setDatabase(databaseConfig)
    .getResult();
};

const getFirebaseConfigTemplate = (build: "bare" | "rnef") => {
  const storageConfig: ProviderConfig = {
    imports: [{ pkg: "@hot-updater/firebase", named: ["firebaseStorage"] }],
    configString: `firebaseStorage({
    projectId: process.env.HOT_UPDATER_FIREBASE_PROJECT_ID!,
    storageBucket: process.env.HOT_UPDATER_FIREBASE_STORAGE_BUCKET!,
    credential,
  })`,
  };
  const databaseConfig: ProviderConfig = {
    imports: [{ pkg: "@hot-updater/firebase", named: ["firebaseDatabase"] }],
    configString: `firebaseDatabase({
    projectId: process.env.HOT_UPDATER_FIREBASE_PROJECT_ID!,
    credential,
  })`,
  };

  const intermediate = `
// https://firebase.google.com/docs/admin/setup?hl=en#initialize_the_sdk_in_non-google_environments
// Check your .env file and add the credentials
// Set the GOOGLE_APPLICATION_CREDENTIALS environment variable to your credentials file path
// Example: GOOGLE_APPLICATION_CREDENTIALS=./firebase-adminsdk-credentials.json
const credential = admin.credential.applicationDefault();`.trim();

  return new ConfigBuilder()
    .setBuildType(build)
    .setStorage(storageConfig)
    .setDatabase(databaseConfig)
    .addImport({ pkg: "firebase-admin", defaultOrNamespace: "admin" })
    .setIntermediateCode(intermediate)
    .getResult();
};

describe("ConfigBuilder", () => {
  it("should build an AWS S3 config with session token", () => {
    const result = getAwsConfigTemplate("bare", {
      sessionToken: true,
    });

    const expectedConfig = `import { s3Database, s3Storage } from "@hot-updater/aws";
import { bare } from "@hot-updater/bare";
import "dotenv/config";
import { defineConfig } from "hot-updater";

const commonOptions = {
  bucketName: process.env.HOT_UPDATER_S3_BUCKET_NAME!,
  region: process.env.HOT_UPDATER_S3_REGION!,
  credentials: {
    accessKeyId: process.env.HOT_UPDATER_S3_ACCESS_KEY_ID!,
    secretAccessKey: process.env.HOT_UPDATER_S3_SECRET_ACCESS_KEY!,
    // This token may expire. For permanent use, it's recommended to use a key with S3FullAccess and CloudFrontFullAccess permission and remove this field.
    sessionToken: process.env.HOT_UPDATER_S3_SESSION_TOKEN!,
  },
};

export default defineConfig({
  build: bare({ enableHermes: true }),
  storage: s3Storage(commonOptions),
  database: s3Database({
    ...commonOptions,
    cloudfrontDistributionId: process.env.HOT_UPDATER_CLOUDFRONT_DISTRIBUTION_ID!,
  }),
});`;

    expect(result).toBe(expectedConfig);
  });

  it("should build an AWS S3 config without session token", () => {
    const result = getAwsConfigTemplate("bare", {
      sessionToken: false,
    });

    const expectedConfig = `import { s3Database, s3Storage } from "@hot-updater/aws";
import { bare } from "@hot-updater/bare";
import "dotenv/config";
import { defineConfig } from "hot-updater";

const commonOptions = {
  bucketName: process.env.HOT_UPDATER_S3_BUCKET_NAME!,
  region: process.env.HOT_UPDATER_S3_REGION!,
  credentials: {
    accessKeyId: process.env.HOT_UPDATER_S3_ACCESS_KEY_ID!,
    secretAccessKey: process.env.HOT_UPDATER_S3_SECRET_ACCESS_KEY!,
  },
};

export default defineConfig({
  build: bare({ enableHermes: true }),
  storage: s3Storage(commonOptions),
  database: s3Database({
    ...commonOptions,
    cloudfrontDistributionId: process.env.HOT_UPDATER_CLOUDFRONT_DISTRIBUTION_ID!,
  }),
});`;

    expect(result).toBe(expectedConfig);
  });

  it("should build a Supabase config", () => {
    const result = getSupabaseConfigTemplate("bare");

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

  it("should build a Cloudflare config", () => {
    const result = getCloudflareConfigTemplate("bare");

    const expectedConfig = `import { bare } from "@hot-updater/bare";
import { d1Database, r2Storage } from "@hot-updater/cloudflare";
import "dotenv/config";
import { defineConfig } from "hot-updater";


export default defineConfig({
  build: bare({ enableHermes: true }),
  storage: r2Storage({
    bucketName: process.env.HOT_UPDATER_CLOUDFLARE_R2_BUCKET_NAME!,
    accountId: process.env.HOT_UPDATER_CLOUDFLARE_ACCOUNT_ID!,
    cloudflareApiToken: process.env.HOT_UPDATER_CLOUDFLARE_API_TOKEN!,
  }),
  database: d1Database({
    databaseId: process.env.HOT_UPDATER_CLOUDFLARE_D1_DATABASE_ID!,
    accountId: process.env.HOT_UPDATER_CLOUDFLARE_ACCOUNT_ID!,
    cloudflareApiToken: process.env.HOT_UPDATER_CLOUDFLARE_API_TOKEN!,
  }),
});`;

    expect(result).toBe(expectedConfig);
  });

  it("should build a Cloudflare config", () => {
    const result = getCloudflareConfigTemplate("rnef");

    const expectedConfig = `import { d1Database, r2Storage } from "@hot-updater/cloudflare";
import { rnef } from "@hot-updater/rnef";
import "dotenv/config";
import { defineConfig } from "hot-updater";


export default defineConfig({
  build: rnef(),
  storage: r2Storage({
    bucketName: process.env.HOT_UPDATER_CLOUDFLARE_R2_BUCKET_NAME!,
    accountId: process.env.HOT_UPDATER_CLOUDFLARE_ACCOUNT_ID!,
    cloudflareApiToken: process.env.HOT_UPDATER_CLOUDFLARE_API_TOKEN!,
  }),
  database: d1Database({
    databaseId: process.env.HOT_UPDATER_CLOUDFLARE_D1_DATABASE_ID!,
    accountId: process.env.HOT_UPDATER_CLOUDFLARE_ACCOUNT_ID!,
    cloudflareApiToken: process.env.HOT_UPDATER_CLOUDFLARE_API_TOKEN!,
  }),
});`;

    expect(result).toBe(expectedConfig);
  });

  it("should build a Firebase config", () => {
    const result = getFirebaseConfigTemplate("bare");

    const expectedConfig = `import { bare } from "@hot-updater/bare";
import { firebaseDatabase, firebaseStorage } from "@hot-updater/firebase";
import "dotenv/config";
import * as admin from "firebase-admin";
import { defineConfig } from "hot-updater";

// https://firebase.google.com/docs/admin/setup?hl=en#initialize_the_sdk_in_non-google_environments
// Check your .env file and add the credentials
// Set the GOOGLE_APPLICATION_CREDENTIALS environment variable to your credentials file path
// Example: GOOGLE_APPLICATION_CREDENTIALS=./firebase-adminsdk-credentials.json
const credential = admin.credential.applicationDefault();

export default defineConfig({
  build: bare({ enableHermes: true }),
  storage: firebaseStorage({
    projectId: process.env.HOT_UPDATER_FIREBASE_PROJECT_ID!,
    storageBucket: process.env.HOT_UPDATER_FIREBASE_STORAGE_BUCKET!,
    credential,
  }),
  database: firebaseDatabase({
    projectId: process.env.HOT_UPDATER_FIREBASE_PROJECT_ID!,
    credential,
  }),
});`;

    expect(result).toBe(expectedConfig);
  });

  //   it("should build a Firebase config with rnef", () => {
  //     const result = getFirebaseConfigTemplate("rnef");

  //     const expectedConfig = `import { firebaseDatabase, firebaseStorage } from "@hot-updater/firebase";
  // import { rnef } from "@hot-updater/rnef";
  // import admin from "firebase-admin";
  // import "dotenv/config";
  // import { defineConfig } from "hot-updater";

  // // https://firebase.google.com/docs/admin/setup?hl=en#initialize_the_sdk_in_non-google_environments
  // // Check your .env file and add the credentials
  // // Set the GOOGLE_APPLICATION_CREDENTIALS environment variable to your credentials file path
  // // Example: GOOGLE_APPLICATION_CREDENTIALS=./firebase-adminsdk-credentials.json
  // const credential = admin.credential.applicationDefault();

  // export default defineConfig({
  //   build: rnef(),
  //   storage: firebaseStorage({
  //     projectId: process.env.HOT_UPDATER_FIREBASE_PROJECT_ID!,
  //     storageBucket: process.env.HOT_UPDATER_FIREBASE_STORAGE_BUCKET!,
  //     credential,
  //   }),
  //   database: firebaseDatabase({
  //     projectId: process.env.HOT_UPDATER_FIREBASE_PROJECT_ID!,
  //     credential,
  //   }),
  // });`;

  //     expect(result).toBe(expectedConfig);
  //   });
});

  # Hot Updater
  
  ## DI Fork
  This is the DI fork of hot-updater. For DI specific documentation, see the [DI docs](https://github.com/distribution-innovation/di-docs/blob/main/Frontend/mobile/how-to/deploy-hot-updater-infrastructure.md).

[![NPM](https://img.shields.io/npm/v/hot-updater)](https://www.npmjs.com/package/hot-updater)

  A self-hostable OTA update solution for React Native **(Alternative to CodePush)**

  ![hot-updater](https://raw.githubusercontent.com/gronxb/hot-updater/main/demo.gif)


  ## Documentation

  Full documentation is available at:
  https://gronxb.github.io/hot-updater

  ## Key Features

  - **Self-Hosted**: Complete control over your update infrastructure
  - **Multi-Platform**: Support for both iOS and Android
  - **Web Console**: Intuitive update management interface
  - **Plugin System**: Support for various storage providers (AWS S3, Cloudflare R2 + D1, etc.)
  - **Version Control**: Robust app version management through semantic versioning
  - **New Architecture**: Support for new architecture like React Native


  ## Plugin System

  Hot Updater provides high extensibility through its plugin system. Each functionality like build, storage, and database is separated into plugins, allowing users to configure them according to their needs.

  ### Plugin Types

  - **Build Plugin**: Support for bundlers like Metro, Re.Pack, Expo
  - **Storage Plugin**: Support for bundle storage like AWS S3, Supabase Storage, Cloudflare R2 Storage
  - **Database Plugin**: Support for metadata storage like Supabase Database, PostgreSQL, Cloudflare D1

  ### Configuration Example

  * [Supabase](https://gronxb.github.io/hot-updater/guide/providers/1_supabase.html)
  ```tsx
  import { bare } from "@hot-updater/bare";
  import { supabaseDatabase, supabaseStorage } from "@hot-updater/supabase";
  import { defineConfig } from "hot-updater";
  import "dotenv/config";

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
  });
  ```

* [Cloudflare](https://gronxb.github.io/hot-updater/guide/providers/2_cloudflare.html)
```tsx
import { bare } from "@hot-updater/bare";
import { d1Database, r2Storage } from "@hot-updater/cloudflare";
import { defineConfig } from "hot-updater";
import "dotenv/config";

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
});
```

* [AWS S3 + Lambda@Edge](https://gronxb.github.io/hot-updater/guide/providers/3_aws-s3-lambda-edge.html)
```tsx
import { bare } from "@hot-updater/bare";
import { s3Storage, s3Database } from "@hot-updater/aws";
import { defineConfig } from "hot-updater";
import "dotenv/config";

const options = {
  bucketName: process.env.HOT_UPDATER_S3_BUCKET_NAME!,
  region: process.env.HOT_UPDATER_S3_REGION!,
  credentials: {
    accessKeyId: process.env.HOT_UPDATER_S3_ACCESS_KEY_ID!,
    secretAccessKey: process.env.HOT_UPDATER_S3_SECRET_ACCESS_KEY!,
  },
};

export default defineConfig({
  build: bare({ enableHermes: true }),
  storage: s3Storage(options),
  database: s3Database(options),
});
```

* [Firebase](https://gronxb.github.io/hot-updater/guide/providers/4_firebase.html)
```tsx
import { bare } from '@hot-updater/bare';
import {firebaseStorage, firebaseDatabase} from '@hot-updater/firebase';
import * as admin from 'firebase-admin';
import { defineConfig } from 'hot-updater';
import 'dotenv/config';

// https://firebase.google.com/docs/admin/setup?hl=en#initialize_the_sdk_in_non-google_environments
// Check your .env file and add the credentials
// Set the GOOGLE_APPLICATION_CREDENTIALS environment variable to your credentials file path
// Example: GOOGLE_APPLICATION_CREDENTIALS=./firebase-adminsdk-credentials.json
const credential = admin.credential.applicationDefault();

export default defineConfig({
  build: bare({
    enableHermes: true,
  }),
  storage: firebaseStorage({
    projectId: process.env.HOT_UPDATER_FIREBASE_PROJECT_ID!,
    storageBucket: process.env.HOT_UPDATER_FIREBASE_STORAGE_BUCKET!,
    credential,
  }),
  database: firebaseDatabase({
    projectId: process.env.HOT_UPDATER_FIREBASE_PROJECT_ID!,
    credential,
  }),
});
```



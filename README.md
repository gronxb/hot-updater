  # Hot Updater

<a href="https://vercel.com/oss">
  <img alt="Vercel OSS Program" src="https://vercel.com/oss/program-badge-2026.svg" />
</a>
  
<br />
<br />

  
[![NPM](https://img.shields.io/npm/v/hot-updater)](https://www.npmjs.com/package/hot-updater)
[![pkg.pr.new](https://pkg.pr.new/badge/gronxb/hot-updater)](https://pkg.pr.new/~/gronxb/hot-updater)

  
  <img width="2594" height="1264" alt="image" src="https://github.com/user-attachments/assets/82c52334-a0c2-48d4-a9f1-8d9c45e79bb2" />


  ![hot-updater](https://raw.githubusercontent.com/gronxb/hot-updater/main/demo.gif)


  ## Documentation

  Full documentation is available at:
  https://hot-updater.dev

  ## AI Skills

  Attach the Hot Updater agent skill so AI coding agents can use concise CLI
  context for deploys, bundle management, rollbacks, and verification:
  [`skills/hot-updater/SKILL.md`](https://github.com/hot-updater/skills/blob/main/skills/hot-updater/SKILL.md)

  ```sh
  npx skills add hot-updater/skills
  ```

  Then ask your agent with prompts like
  `$hot-updater deploy using the current app version` or
  `$hot-updater roll back the most recently deployed bundle`.

  See the [AI Agent Guide](https://hot-updater.dev/docs/guides/ai-agents) for
  the full workflow.

  ## Key Features

  - **Self-Hosted**: Complete control over your update infrastructure
  - **Multi-Platform**: Support for both iOS and Android
  - **Web Console**: Intuitive update management interface
  - **Bundle Diffing**: Reuse unchanged files and ship compact Hermes patches
    for smaller OTA downloads
  - **Extension System**: Storage plugins for AWS S3 and Cloudflare R2, plus
    database adapters such as D1
  - **Version Control**: Robust app version management through semantic versioning
  - **New Architecture**: Support for new architecture like React Native
  - **Transition Analytics**: Optional Installed/Recovered OTA evidence plus per-install last-known bundle history



  ## Bundle Diffing

  Hot Updater can deliver incremental OTA updates instead of making every
  device download the full archive again. A diff-enabled runtime reuses bundle
  files that already exist on the device, while deploys prepare `.bsdiff`
  patches for changed Hermes bundles by default.

  In practice, a release that would normally ship a 10 MB archive can be
  delivered as a ~600 KB patch when the Hermes bytecode change is small. If a
  patch is missing, incompatible, or not worth using, Hot Updater falls back to
  the normal archive update path.

  See the [Bundle Diffing guide](https://hot-updater.dev/docs/guides/bundle-diffing)
  for the full runtime behavior and fallback rules.

  ## OTA Transition Analytics

  Hot Updater can optionally record successful OTA applications and automatic recoveries as append-only transition events. The runtime keeps this opt-in behind `HotUpdater.init({ analytics: true })`, the server stores immutable `bundle_events`, and the Console surfaces lifetime Installed/Recovered counts plus per-install last-known bundle history.

  See the React Native/runtime docs and Console/server guides at https://hot-updater.dev for full setup.


  ## Extension System

  Hot Updater provides high extensibility through build and storage plugins plus database adapters, allowing users to configure each integration according to their needs.

  ### Extension Types

  - **Build Plugin**: Support for bundlers like Metro, Re.Pack, Expo
  - **Storage Plugin**: Support for bundle storage like AWS S3, Supabase Storage, Cloudflare R2 Storage
  - **Database Adapter**: Support for metadata storage like Supabase Database, PostgreSQL, Cloudflare D1

  ### Configuration Example

  * [Supabase](https://hot-updater.dev/docs/managed/supabase)
  ```tsx
  import { bare } from "@hot-updater/bare";
  import { supabaseDatabase, supabaseStorage } from "@hot-updater/supabase";
  import { config } from "dotenv";
  import { defineConfig } from "hot-updater";

  config({ path: ".env.hotupdater" });

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

* [Cloudflare](https://hot-updater.dev/docs/managed/cloudflare)
```tsx
import { bare } from "@hot-updater/bare";
import { d1Database, r2Storage } from "@hot-updater/cloudflare";
import { config } from "dotenv";
import { defineConfig } from "hot-updater";

config({ path: ".env.hotupdater" });

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

* [AWS S3 + Lambda@Edge](https://hot-updater.dev/docs/managed/aws)
```tsx
import { bare } from "@hot-updater/bare";
import { s3Storage, s3Database } from "@hot-updater/aws";
import { config } from "dotenv";
import { defineConfig } from "hot-updater";

config({ path: ".env.hotupdater" });

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

* [Firebase](https://hot-updater.dev/docs/managed/firebase)
```tsx
import { bare } from '@hot-updater/bare';
import {firebaseStorage, firebaseDatabase} from '@hot-updater/firebase';
import * as admin from 'firebase-admin';
import { config } from "dotenv";
import { defineConfig } from "hot-updater";

config({ path: ".env.hotupdater" });

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

# Firebase setup

Read COMMON.md. The firebase/ directory is a prepared second-generation Cloud
Functions project with Firestore indexes. Use available Firebase/Google Cloud
MCP/API tools, Firebase CLI, or the browser for account-only prerequisites.

1. **Project.** Confirm project ID, region and resource reuse. Query before
   creation. A v0 project may be reused: v1 uses hot_updater_v1_* collections and
   a separate hot-updater-v1 function. Preserve v0 collections/functions and
   inspect the v1 namespace for partial/incompatible data before adoption.
2. **Service readiness.** Verify required billing, Cloud Functions/Cloud Build/
   Artifact Registry APIs, default Firestore database, and the actual default
   Storage bucket. Use the provider-reported bucket name; do not guess its
   suffix. Resolve missing billing or access with the user when necessary.
3. **Runtime identity.** Verify that the deployed runtime's application-default
   identity can access Firestore and the selected storage bucket. The supplied
   runtime expects Firebase app options to include storageBucket. Preserve
   existing storage access policies and optional HOT_UPDATER_CDN_URL settings.
4. **Indexes.** Merge firebase/firestore.indexes.json into existing indexes and
   deploy. With CLI, run `npx firebase deploy --only firestore:indexes --project
   <project-id>` from firebase/. Preserve unrelated indexes and rules. Wait for
   index readiness; do not assume a successful request means indexes are ready.
5. **Function.** Fill the project ID in .firebaserc and the region placeholder
   in functions/index.cjs. Install the pinned functions/package.json dependencies.
   Deploy only hot-updater-v1, keeping its existing region when reusing it:
   `npx firebase deploy --only functions:hot-updater-v1 --project <project-id>`.
   Verify public invocation reaches the runtime, which validates x-api-key.
   Use the function URL reported by the provider. Do not deploy Hosting: an
   existing default Hosting site may belong to the app or its v0 endpoint.
6. **Local access and key.** Complete COMMON.md with project ID, region, actual
   storage bucket and local application-default/service-account credentials.
   Register/reuse the client key after the v1 namespace is ready. Keep admin
   credentials out of the app and preserve existing client key records.
7. **Verify.** Check the direct function URL's /ping, /version and authenticated
   client requests. Record actual project/function/region and deployed version.
   Inspect logs and retry only failed steps with the same resources.

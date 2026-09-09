# Firebase setup checklist

For an already initialized 1.0.0 RC namespace, inspect actual Insights fields;
the unchanged version marker does not identify the current event layout.
Fresh storage uses event `metadata` and no shared installation table. Follow the
packaged 1.0.0 infrastructure upgrade's offline export/replay procedure for old
flat-event data before deploying matching code. Preserve non-Insights data,
artifacts, endpoint and credentials; do not rerun initialization as a conversion.


Read COMMON.md first. Follow these steps in order and record verified observations
in deployment.json. Use available Firebase/Google Cloud tools; CLI paths below
are relative to this scaffold. The firebase/ project contains the same prepared
second-generation Function runtime and indexes as interactive init. Before using
the CLI fallback, install `firebase-tools` as an app development dependency with
its package manager and verify the local `firebase --version` binary. Use Firebase
CLI 15.29.0 or newer for the generated Functions 7 runtime; older emulators call
the removed `functions.config()` API. Local Firestore emulator checks require
Java 21 or newer. The Firebase client SDK package does not
supply this CLI. Do this before remote provisioning.

- [ ] **fb.project — Select or create the project**
  - Inputs: workspace configuration, authenticated account and established region.
  - Run: query existing projects before selecting/creating one; record its intended
    ID before creation. Inspect an existing namespace/function and upgrade files.
    A legacy project may be reused with separate hot_updater_v1_* collections and
    hot-updater-v1 Function; preserve old collections/functions.
  - Verify/record: projectId and region; ownership and compatible reuse established.
  - Retry: query the same project ID/creation operation before another request.

- [ ] **fb.services — Prepare the services**
  - Requires: fb.project.
  - Run: verify billing, Cloud Functions/Cloud Build/Artifact Registry and IAM
    Service Account Credentials APIs. Create the default Firestore database and
    enable Storage when missing and authorized. Ask only for prerequisites that
    require user involvement. Query the canonical default bucket; never guess its suffix.
  - Verify/record: database ready, APIs available, actual bucketName recorded.
    Check each service independently; project creation alone is not this step's success.
  - Retry: inspect each service's readiness, retain completed resources and continue
    unfinished setup. A newly created project does not require restarting the whole flow.

- [ ] **fb.indexes — Prepare Firestore indexes**
  - Requires: fb.services.
  - Run: merge firebase/firestore.indexes.json with existing indexes, preserving
    unrelated indexes/rules. From firebase/ run
    `npx firebase deploy --only firestore:indexes --project <project-id>`.
  - Verify/record: required indexes are ready in the selected project, not merely
    accepted for creation. Record the target/index readiness.
  - Retry: inspect current indexes and wait for building ones; do not remove/recreate them.

- [ ] **fb.database-key — Initialize the adapter and register the client key**
  - Requires: fb.indexes. Complete this before Function deployment, as init does.
  - Run: follow COMMON.md's Local CLI and client API key steps with working local
    ADC/service-account access. A Firebase CLI/MCP login alone may not authenticate
    the Admin SDK. Run app/provision-api-key.mjs from the app directory.
    Its first DB operation initializes a fresh compatible namespace and creates
    the adapter version marker automatically before registering the key.
  - Verify/record: helper succeeds against the chosen project and the key is
    persisted privately. An absent marker in a new empty namespace is expected
    before the helper; do not require or manually create it as a prerequisite.
  - Retry: the helper rejects incompatible markers/data. Investigate those errors;
    never overwrite the marker, bypass compatibility checks or rotate the saved key.

- [ ] **fb.function — Deploy the server**
  - Requires: fb.database-key.
  - Run: fill project ID in firebase/.firebaserc and region in functions/index.cjs.
    Install pinned functions/package.json dependencies. From firebase/ deploy only
    `npx firebase deploy --only functions:hot-updater-v1 --project <project-id>`.
    Preserve the existing region and optional HOT_UPDATER_CDN_URL setting.
    Use the direct Function URL; do not deploy Hosting or replace an app's default site.
  - Verify/record: actual function name/region, active deployment and baseUrl. Query
    the deployed runtime service account now; it need not exist before first deployment.
  - Retry: inspect deployment status/logs and reuse the same project, indexes and function.

- [ ] **fb.runtime-access — Verify runtime permissions and signing**
  - Requires: fb.function. Use its actual runtime identity, not the local ADC identity.
  - Run: verify Firestore/Storage access and actual storageBucket app option.
    Download signing requires the IAM Service Account Credentials API and
    iam.serviceAccounts.signBlob on that runtime service account itself. Reuse
    a working grant or grant roles/iam.serviceAccountTokenCreator to the runtime
    identity on itself. Init's existing project-level grant also satisfies this.
    Preserve unrelated IAM bindings and storage policies. Do not upload local
    service-account credential files to the Function or app.
  - Verify/record: runtime service account, effective access and signing permission.
    See [Google Cloud signing requirements](https://cloud.google.com/storage/docs/authentication/creating-signatures).
  - Retry: inspect the same identity's permissions and API readiness; do not create
    another service account or download a new private key to resolve propagation.

- [ ] **fb.complete — Verify and report**
  - Requires: fb.runtime-access.
  - Run: check the direct Function /ping and complete common.verify,
    common.local and common.report in COMMON.md.
  - Verify/record: target version/generation, catalog authentication and local
    configuration pass. Resolve/download an existing artifact when available:
    /version and an empty catalog do not exercise runtime signing. Report app
    integration/OTA validation separately from server readiness.
  - Retry: inspect the failing check and corresponding step, preserving verified resources.

import type { InitProvider } from "./initProviders";

type Instructions = readonly [string, ...string[]];

export interface InfrastructureUpdate {
  readonly version: string;
  readonly note: string;
  readonly compatibility: string;
  readonly steps: Instructions;
  readonly providers: Readonly<Record<InitProvider, Instructions>>;
  readonly verification: Instructions;
}

// Doctor requirements and packaged agent upgrade notes share this registry.
// Every new requirement must describe the migration for all managed providers.
export const INFRASTRUCTURE_UPDATES = [
  {
    version: "1.0.0",
    note: "Release Catalog infrastructure generation",
    compatibility:
      "Generation 0 cannot be upgraded in place. Create separate generation 1 resources and ship the new endpoint in a new native build. Preserve the old infrastructure for installed apps. For existing generation 1 installations, preserve resource IDs, client API keys, signing keys, and endpoints.",
    steps: [
      "For v0 to v1: record the old endpoint, resource IDs, config and credential locations, and back up metadata. Keep v0 endpoints and databases serving installed v0 binaries throughout adoption.",
      "Create a separate v1 database namespace and endpoint. Buckets may be shared when existing objects and access policies are preserved; never prune shared storage based only on the empty v1 database. v0 Bundle history and policy are not backfilled: redeploy desired Bundles from their source artifacts.",
      "Inspect the live /version response and existing schema before changing resources. Confirm infrastructureGeneration is 1 before applying an in-place update.",
      "Compare the previous deployment manifest and customized files with this target scaffold. Apply pending migrations before deploying code that depends on them; preserve existing data and migration history.",
      "The v1 runtime uses authenticated Release Catalog requests. Preserve client API key records and configure x-api-key in the app. Provider admin credentials must stay on the server or deployment machine.",
      "Upgrade hot-updater and @hot-updater packages together. Do not deliver v1 React Native SDK JavaScript to a v0 native binary through OTA. Refresh Expo native projects with expo prebuild or bare iOS dependencies with pod install, then ship a new native build with the v1 SDK and endpoint.",
      "Update automation that parsed v0 bundle list/show JSON: v1 returns raw internal rows. Roll back a v1 mobile release with another native build or a compatible v1 deployment; never point v1 binaries at v0 infrastructure. Retire v0 only after an explicit adoption decision.",
    ],
    providers: {
      cloudflare: [
        "Use a separate D1 database and Worker for generation 0. On generation 1, inspect D1 migration history and apply only pending supplied migrations. Preserve the R2 bucket and STORAGE_DOWNLOAD_URL_SIGNING_KEY.",
        "Deploy the supplied Worker with DB and BUCKET bindings, BUCKET_NAME, and the template's cache settings and compatibility date.",
      ],
      supabase: [
        "A v0 project can be reused: v1 uses separate hot_updater_v1_* tables and the hot-updater-v1 function. Preserve v0 tables/functions and check the v1 namespace for partial or incompatible schema before applying migrations. Compare migration history with the supplied SQL, preserving the existing storage bucket and privacy setting.",
        "Deploy the prepared Edge Function and Deno imports with platform JWT verification disabled; the supplied runtime authenticates x-api-key. Preserve the function name and URL. Origin-only catalog checks continue to invoke the function.",
      ],
      aws: [
        "Use separate DynamoDB, Lambda@Edge, and CloudFront resources for generation 0. Do not reuse a v0 Lambda name or distribution ID. The S3 bucket can be shared with existing policies preserved. Isolate v1 IAM roles and signing keys; the v1 SSM path is /hot-updater/v1/<lambda-name>/keypair. On generation 1, verify the table/index schema, point-in-time recovery, and IAM permissions before deployment. Preserve existing v1 SSM signing keys and client API key records.",
        "Publish a numbered Lambda version in us-east-1 and update the existing distribution's managed behaviors. Preserve unrelated behaviors. Apply the supplied API-key-aware cache/origin policies and Release Catalog behavior, then wait for distribution propagation.",
      ],
      firebase: [
        "A v0 project can be reused: v1 uses separate hot_updater_v1_* Firestore collections and the hot-updater-v1 function. Leave v0 collections and the hot-updater function intact. Check the v1 namespace for partial/incompatible schema and merge the supplied Firestore indexes with existing indexes. Wait for readiness and preserve storage and client API key records.",
        "Deploy hot-updater-v1 in its existing region with the supplied Functions runtime. Preserve the existing storage bucket, runtime identity, endpoint, and any CDN settings.",
      ],
    },
    verification: [
      "Check /version for infrastructureGeneration 1 and the target server version. Run hot-updater doctor --json --server-base-url <base-url> from the app directory.",
      "Verify an authenticated client request and a known stored artifact when available. Record the actual deployed version only after verification. Report native app rebuild or OTA runtime validation separately.",
      "For v0 to v1, verify the old endpoint still serves v0 binaries and the new native build uses v1. Test catalog fetch, artifact resolution, install, restart and rollback. The native SDK's local metadata migration does not migrate the old server database.",
    ],
  },
] as const satisfies readonly [InfrastructureUpdate, ...InfrastructureUpdate[]];

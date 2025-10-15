import type { Bundle, GetBundlesArgs, UpdateInfo } from "@hot-updater/core";
import { NIL_UUID } from "@hot-updater/core";
import { setupGetUpdateInfoIntegrationTestSuite } from "@hot-updater/core/test-utils";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, beforeEach, describe } from "vitest";

const SUPABASE_URL = process.env.SUPABASE_URL || "http://127.0.0.1:54321";
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

const FUNCTION_NAME = "hot-updater";
const EDGE_FUNCTION_URL = `${SUPABASE_URL}/functions/v1/${FUNCTION_NAME}`;

let supabase: SupabaseClient;

describe("Supabase Edge Functions Integration Tests", () => {
  beforeAll(async () => {
    supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { error: tablesError } = await supabase.rpc("get_update_info_by_app_version", {
      app_platform: "ios",
      app_version: "1.0",
      bundle_id: NIL_UUID,
      min_bundle_id: NIL_UUID,
      target_channel: "production",
      target_app_version_list: [],
    });

    if (tablesError) {
      console.warn(
        "⚠️  Database tables may not be initialized. Run Supabase migrations first.",
      );
    }
  });

  beforeEach(async () => {
    await supabase.from("bundles").delete().neq("id", NIL_UUID);
  });

  setupGetUpdateInfoIntegrationTestSuite({
    setupBundles: async (bundles: Bundle[]) => {
      if (bundles.length === 0) return;

      const bundleRows = bundles.map((bundle) => ({
        id: bundle.id,
        file_hash: bundle.fileHash,
        platform: bundle.platform,
        target_app_version: bundle.targetAppVersion || null,
        should_force_update: bundle.shouldForceUpdate,
        enabled: bundle.enabled,
        git_commit_hash: bundle.gitCommitHash || null,
        message: bundle.message || null,
        channel: bundle.channel || "production",
        storage_uri: bundle.storageUri || null,
        fingerprint_hash: bundle.fingerprintHash || null,
      }));

      const { error } = await supabase.from("bundles").insert(bundleRows);

      if (error) {
        throw new Error(`Failed to insert bundles: ${error.message}`);
      }
    },

    cleanup: async () => {
      await supabase.from("bundles").delete().neq("id", NIL_UUID);
    },

    fetchUpdateInfo: async (args: GetBundlesArgs): Promise<UpdateInfo | null> => {
      const headers: Record<string, string> = {
        "x-bundle-id": args.bundleId,
        "x-app-platform": args.platform,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      };

      if (args._updateStrategy === "appVersion") {
        headers["x-app-version"] = args.appVersion;
      } else {
        headers["x-fingerprint-hash"] = args.fingerprintHash;
      }

      if (args.minBundleId && args.minBundleId !== NIL_UUID) {
        headers["x-min-bundle-id"] = args.minBundleId;
      }

      if (args.channel) {
        headers["x-channel"] = args.channel;
      }

      const response = await fetch(EDGE_FUNCTION_URL, {
        method: "GET",
        headers,
      });

      if (!response.ok) {
        return null;
      }

      const data = await response.json();

      if (!data || !data.id) {
        return null;
      }

      return {
        id: data.id,
        shouldForceUpdate: data.shouldForceUpdate,
        status: data.status,
        message: data.message,
        storageUri: data.fileUrl || null,
      };
    },
  });
});

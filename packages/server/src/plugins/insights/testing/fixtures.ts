import type { BundleEventRow } from "@hot-updater/plugin-core";

const fixtureId = (suffix: string): string =>
  `00000000-0000-7000-8000-${suffix.padStart(12, "0")}`;

/** An applied update from install `suffix`, received at `receivedAtMs`. */
export const createBundleEventRowFixture = (
  suffix: string,
  receivedAtMs: number,
): Extract<BundleEventRow, { type: "UPDATE_APPLIED" | "RECOVERED" }> => ({
  id: fixtureId(suffix),
  type: "UPDATE_APPLIED",
  install_id: `install-${suffix}`,
  user_id: null,
  metadata: {
    username: null,
    cohort: "0",
    update_strategy: "appVersion",
    fingerprint_hash: null,
    sdk_version: null,
  },
  from_bundle_id: fixtureId(`${Number(suffix) + 1000}`),
  from_release_id: null,
  to_bundle_id: fixtureId(`${Number(suffix) + 2000}`),
  to_release_id: null,
  platform: "ios",
  app_version: "1.0.0",
  channel: "production",

  received_at_ms: receivedAtMs,
});

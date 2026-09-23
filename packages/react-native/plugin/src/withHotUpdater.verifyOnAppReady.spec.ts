import type { ExpoConfig } from "expo/config";
import { beforeEach, describe, expect, it, vi } from "vitest";

type ModAction = (config: {
  modResults: Record<string, unknown>;
}) => Promise<{ modResults: Record<string, unknown> }>;

const modActions = vi.hoisted(() => ({
  androidManifest: [] as ModAction[],
  infoPlist: [] as ModAction[],
}));

vi.mock("expo/config-plugins", async (importOriginal) => {
  const actual = await importOriginal<typeof import("expo/config-plugins")>();
  return {
    ...actual,
    withAndroidManifest: (config: ExpoConfig, action: ModAction) => {
      modActions.androidManifest.push(action);
      return config;
    },
    withInfoPlist: (config: ExpoConfig, action: ModAction) => {
      modActions.infoPlist.push(action);
      return config;
    },
  };
});

vi.mock("@hot-updater/cli-tools", () => ({
  loadConfig: async () => ({ updateStrategy: "appVersion" }),
}));

const VERIFY_META_DATA = "com.hotupdater.VERIFY_ON_APP_READY";

const applyPlugin = async (
  props: { verifyOnAppReady?: boolean },
  existing: { infoPlist: Record<string, unknown>; metaData: unknown[] },
) => {
  const { default: withHotUpdater } = await import("./withHotUpdater");
  withHotUpdater(
    { _internal: { projectRoot: process.cwd() }, name: "app", slug: "app" },
    props,
  );

  const [infoPlistAction] = modActions.infoPlist;
  const [androidManifestAction] = modActions.androidManifest;
  const infoPlist = await infoPlistAction!({
    modResults: { ...existing.infoPlist },
  });
  const androidManifest = await androidManifestAction!({
    modResults: {
      manifest: { application: [{ "meta-data": [...existing.metaData] }] },
    },
  });
  const application = (
    androidManifest.modResults.manifest as {
      application: { "meta-data"?: { $: Record<string, string> }[] }[];
    }
  ).application[0];

  return {
    infoPlist: infoPlist.modResults,
    metaData: application?.["meta-data"] ?? [],
  };
};

describe("withHotUpdater verifyOnAppReady", () => {
  beforeEach(() => {
    vi.resetModules();
    modActions.androidManifest.length = 0;
    modActions.infoPlist.length = 0;
  });

  it("writes the Info.plist key and manifest meta-data when enabled", async () => {
    const { infoPlist, metaData } = await applyPlugin(
      { verifyOnAppReady: true },
      { infoPlist: {}, metaData: [] },
    );

    expect(infoPlist.HOT_UPDATER_VERIFY_ON_APP_READY).toBe(true);
    expect(metaData).toContainEqual({
      $: { "android:name": VERIFY_META_DATA, "android:value": "true" },
    });
  });

  it("removes a key an earlier prebuild wrote when the option is off", async () => {
    const { infoPlist, metaData } = await applyPlugin(
      {},
      {
        infoPlist: { HOT_UPDATER_VERIFY_ON_APP_READY: true },
        metaData: [
          { $: { "android:name": VERIFY_META_DATA, "android:value": "true" } },
        ],
      },
    );

    expect(infoPlist).not.toHaveProperty("HOT_UPDATER_VERIFY_ON_APP_READY");
    expect(
      metaData.some(
        (item) =>
          (item as { $: Record<string, string> }).$["android:name"] ===
          VERIFY_META_DATA,
      ),
    ).toBe(false);
  });
});

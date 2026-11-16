/**
 * `releases.scopes` on a key-value store: an item's sort key is its scope
 * key and the release ID, 38 bytes longer than the scope's catalog row's.
 * A scope's channel bounds it: a channel row's `all` item holds the name
 * and the ID `channel:<base64url of the name>`, so the longest channel a
 * store holds makes a scope whose `scopes` items still fit. These cases
 * hold that on DynamoDB's and Firestore's key limits.
 */
import {
  createEngineDatabase,
  createKvAdapter,
  type HotUpdaterCoreApi,
  type KeyValueStore,
  type KvKey,
} from "@hot-updater/plugin-core";
import {
  createMemoryKeyValueStore,
  createReleaseCatalogTestStorage,
} from "@hot-updater/test-utils";
import { describe, expect, it } from "vitest";

import { createHotUpdater } from "../../index";

/** The partition and sort key bytes each store indexes whole. */
const KEY_BYTES = {
  // DYNAMODB_LIMITS in @hot-updater/aws
  dynamodb: { pk: 2_048, sk: 1_024 },
  // FIRESTORE_LIMITS in @hot-updater/firebase
  firestore: { pk: 1_500, sk: 1_500 },
} as const;
const SCOPES = { pk: "releases#scopes#", order: "asc", limit: 500 } as const;
/** The longest fingerprint a scope key takes. */
const FINGERPRINT = "f".repeat(255);
const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).length;

let sequence = 0;
const nextId = () =>
  `01900000-0000-7000-8000-${String((sequence += 1)).padStart(12, "0")}`;

/**
 * A core over a memory key-value store with `keyBytes`. With `skip`, the
 * store takes items of that partition whatever their keys' size, as if the
 * index weren't declared, and refuses the rest past the limits.
 */
const coreOn = async (
  keyBytes: { readonly pk: number; readonly sk: number },
  skip?: string,
) => {
  const store = createMemoryKeyValueStore();
  const fits = ({ pk, sk }: KvKey) =>
    pk === skip || (bytes(pk) <= keyBytes.pk && bytes(sk) <= keyBytes.sk);
  const keyed: KeyValueStore = {
    ...store,
    limits: skip === undefined ? { ...store.limits, keyBytes } : store.limits,
    write: (ops) => {
      if (!ops.every(({ key }) => fits(key))) {
        throw new Error("A key exceeds the store's limit.");
      }
      return store.write(ops);
    },
  };
  const database = createEngineDatabase({
    name: "kv",
    adapter: createKvAdapter({ store: keyed }),
  });
  await (await database.createMigrator!().migrateToLatest()).execute();
  const { core } = createHotUpdater({
    database,
    storage: createReleaseCatalogTestStorage(),
    clientAccess: "public",
  }) as unknown as { core: HotUpdaterCoreApi };
  return { core, store };
};

type Scope =
  | { readonly platform: "ios" | "android"; readonly appVersion: string }
  | {
      readonly platform: "ios" | "android";
      readonly fingerprintHash: string;
    };

const APP_VERSION: Scope = { platform: "ios", appVersion: "1.0.0" };
const LONGEST_FINGERPRINT: Scope = {
  platform: "android",
  fingerprintHash: FINGERPRINT,
};

/** Deploys one release on `channel`: whether the store took it. */
const deploy = async (
  core: HotUpdaterCoreApi,
  channel: string,
  scope: Scope,
): Promise<boolean> => {
  const id = nextId();
  try {
    await core.deploy([
      {
        bundle: {
          id,
          platform: scope.platform,
          gitCommitHash: null,
          manifestStorageUri: `storage://artifacts/${id}/manifest.json`,
          manifestFileHash: `manifest-hash-${id}`,
          assetBaseStorageUri: "storage://assets",
        },
        release: {
          channel,
          enabled: true,
          fingerprintHash:
            "fingerprintHash" in scope ? scope.fingerprintHash : null,
          message: null,
          shouldForceUpdate: false,
          targetAppVersion: "appVersion" in scope ? scope.appVersion : null,
        },
      },
    ]);
    return true;
  } catch {
    return false;
  }
};

const channelKey = (channel: string) =>
  Buffer.from(channel).toString("base64url");

describe("releases.scopes sort keys on a key-value store", () => {
  it("never meet a channel of 247 `가` on DynamoDB: its own row is refused", async () => {
    const { core } = await coreOn(KEY_BYTES.dynamodb);
    const channel = "가".repeat(247);
    // The scope's catalog row's sort key fits DynamoDB's 1,024 bytes, and
    // a `scopes` item's, 1,045 bytes, wouldn't.
    expect(bytes(`v1:app-version:ios:${channelKey(channel)}`) + 1).toBe(1_008);

    // Its `all` item's sort key: the name, 741 bytes, and the ID, 996.
    await expect(core.ensureChannel(channel)).rejects.toThrow("too_large");
    await expect(deploy(core, channel, APP_VERSION)).resolves.toBe(false);
  });

  // The longest channel each store holds, of the character whose name packs
  // the most base64url into a scope key: 434 bytes on DynamoDB, 636 on
  // Firestore, where 255 characters cap 2-byte names at 510.
  for (const [store, character, length] of [
    ["dynamodb", "ж", 217],
    ["firestore", "가", 212],
  ] as const) {
    it(`take a release on the longest channel ${store} holds, with the longest fingerprint`, async () => {
      const keyBytes = KEY_BYTES[store];
      const { core, store: items } = await coreOn(keyBytes);
      const longest = character.repeat(length);

      await expect(
        core.ensureChannel(character.repeat(length + 1)),
      ).rejects.toThrow("too_large");
      await expect(deploy(core, longest, LONGEST_FINGERPRINT)).resolves.toBe(
        true,
      );
      await expect(deploy(core, longest, APP_VERSION)).resolves.toBe(true);

      const scopeKey = `v1:fingerprint:android:${channelKey(longest)}:${FINGERPRINT}`;
      expect((await core.listReleaseScopeKeys({ limit: 100 })).sort()).toEqual(
        [`v1:app-version:ios:${channelKey(longest)}`, scopeKey].sort(),
      );
      const longestItem = Math.max(
        ...(await items.query(SCOPES)).items.map(({ sk }) => bytes(sk)),
      );
      // The scope key, the release ID, and their separators.
      expect(longestItem).toBe(bytes(scopeKey) + 38);
      expect(longestItem).toBeLessThanOrEqual(keyBytes.sk);
    });
  }

  for (const [store, keyBytes] of Object.entries(KEY_BYTES)) {
    it(`take every release on ${store} that fits without the index`, async () => {
      const withIndex = (await coreOn(keyBytes)).core;
      const withoutIndex = (await coreOn(keyBytes, SCOPES.pk)).core;
      const outcomes = new Set<boolean>();
      // Channels of 1 to 255 characters of 2, 3 and 4 UTF-8 bytes, the
      // longest a channel name takes, in both scope kinds.
      for (const character of ["ж", "가", "😀"]) {
        for (let length = 1; length <= 255; length += 1) {
          const channel = character.repeat(length);
          for (const scope of [APP_VERSION, LONGEST_FINGERPRINT]) {
            const expected = await deploy(withoutIndex, channel, scope);
            outcomes.add(expected);
            await expect(
              deploy(withIndex, channel, scope),
              `${length} × ${character}, ${scope.platform}`,
            ).resolves.toBe(expected);
          }
        }
      }
      // The scan reaches past the longest channel the store holds.
      expect([...outcomes].sort()).toEqual([false, true]);
    });
  }
});

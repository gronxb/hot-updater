import fs from "fs";
import os from "os";
import path from "path";

import type { AscDevice } from "@hot-updater/apple-helper";
import type {
  HotUpdaterCoreApi,
  IosDeviceRow,
  NativeBuildRow,
  StorageAdapter,
} from "@hot-updater/plugin-core";
import {
  blobSource,
  type IpaInstallInfo,
  NativeArtifactError,
  readIpaInstallInfo,
} from "@hot-updater/protocol/native-artifact";

import {
  downloadNativeBuild,
  resolveNativeBuildDownloadUrl,
} from "./downloadNativeBuild";
import { httpRangeSource } from "./httpRangeSource";
import {
  missingIpaDevices,
  nextBuildDeviceOutcome,
} from "./registerApprovedDevices";

/** A device a found `.ipa` lacks that a build now wouldn't add, and why. */
export interface WaitingIosDevice {
  readonly name: string;
  readonly reason: string;
}

/**
 * Whether a registered ad hoc `.ipa` still installs on the device registry's
 * devices, as `native-build find --json` reports it in `iosDevices`.
 */
export interface IosDeviceCoverage {
  /** Whether a run can reuse the build rather than build again. */
  readonly reusable: boolean;
  /**
   * Why it can't: devices a build now would add (`missing`), an expired
   * profile, or a profile that can't be read. Null when it can.
   */
  readonly reason: "missing" | "expired" | "unreadable" | null;
  /**
   * The devices, by name, a build now adds: enabled at Apple in the scheme's
   * account, or approved and not at Apple yet, which a build registers first.
   */
  readonly missing: readonly string[];
  /**
   * The devices the `.ipa` lacks that a build now wouldn't add either, with
   * why: disabled or refused at Apple, another Apple account's, or Apple's
   * state that couldn't be read. They never ask for a build.
   */
  readonly waiting: readonly WaitingIosDevice[];
}

/**
 * Apple's devices in the scheme's account, as the next build reads them, or
 * why they can't be read here: no `signing.ascApiKey`, a pinned profile, or
 * no credentials. A build couldn't add a device then either.
 */
export type AppleDeviceState =
  | {
      readonly kind: "read";
      /** The App Store Connect issuer of the scheme's key. */
      readonly issuerId: string;
      readonly devices: ReadonlyMap<string, Pick<AscDevice, "status">>;
    }
  | { readonly kind: "unavailable"; readonly reason: string };

/** A registry page: past the account's yearly limit, so one page holds every row. */
const PAGE = 200;

/** Every row in a status, a page at a time. */
const listAll = async (
  core: Pick<HotUpdaterCoreApi, "listIosDevices">,
  status: "approved" | "registered",
): Promise<IosDeviceRow[]> => {
  const rows: IosDeviceRow[] = [];
  for (let after: string | undefined; ; ) {
    const page = await core.listIosDevices({
      status,
      limit: PAGE,
      ...(after === undefined ? {} : { after }),
    });
    rows.push(...page);
    if (page.length < PAGE) return rows;
    after = page.at(-1)!.id;
  }
};

/**
 * What a build's `.ipa` says of the registry's devices, recomputed from the
 * artifact and Apple each time, never stored: null for an `.ipa` that lists
 * no devices, which the registry has no part in. A device the `.ipa` lacks
 * asks for a build when the next build would add it, as Apple's current state
 * says, and any other waits. So a device Apple enables later, or one repaired
 * signing can now add, asks for a build, and one Apple can't take never does,
 * whatever the build's age. Apple is read only when the `.ipa` lacks a device.
 */
export const iosDeviceCoverage = async ({
  info,
  devices,
  apple,
  now,
}: {
  /** The `.ipa`'s install info, or null when its profile can't be read. */
  readonly info: IpaInstallInfo | null;
  /** The registry's approved and registered devices. */
  readonly devices: readonly IosDeviceRow[];
  readonly apple: () => Promise<AppleDeviceState>;
  readonly now: number;
}): Promise<IosDeviceCoverage | null> => {
  if (info === null) {
    return { reusable: false, reason: "unreadable", missing: [], waiting: [] };
  }
  if (info.distribution !== "ad-hoc" && info.distribution !== "development") {
    return null;
  }
  if (info.expiresAtMs !== null && info.expiresAtMs <= now) {
    return { reusable: false, reason: "expired", missing: [], waiting: [] };
  }
  // The build's own check of its .ipa, over the registry's rows.
  const lackingIds = new Set(
    missingIpaDevices(devices, info.devices).map(({ id }) => id),
  );
  const lacking = devices.filter(({ id }) => lackingIds.has(id));
  if (lacking.length === 0) {
    return { reusable: true, reason: null, missing: [], waiting: [] };
  }
  const state = await apple().catch(
    (error): AppleDeviceState => ({
      kind: "unavailable",
      reason: `Apple's devices couldn't be read: ${error instanceof Error ? error.message : String(error)}`,
    }),
  );
  const missing: string[] = [];
  const waiting: WaitingIosDevice[] = [];
  for (const row of lacking) {
    const outcome =
      state.kind === "unavailable"
        ? { kind: "pending" as const, reason: state.reason }
        : nextBuildDeviceOutcome(row, state.devices, state.issuerId);
    if (outcome.kind === "pending") {
      waiting.push({ name: row.name, reason: outcome.reason });
    } else {
      missing.push(row.name);
    }
  }
  return {
    reusable: missing.length === 0,
    reason: missing.length === 0 ? null : "missing",
    missing,
    waiting,
  };
};

/**
 * The install info of a stored `.ipa`: its profiles read by Range requests,
 * or from a download when the storage gives no URL that takes them. Null
 * when its profile can't be read; it throws when the artifact can't be
 * reached at all.
 */
const readStoredIpaInstallInfo = async (
  storage: StorageAdapter,
  build: NativeBuildRow,
): Promise<IpaInstallInfo | null> => {
  const url = await resolveNativeBuildDownloadUrl(storage, build);
  if (url !== null) {
    try {
      return await readIpaInstallInfo(
        httpRangeSource({ url, size: build.byte_size }),
      );
    } catch {
      // A storage that ignores Range requests, or parts that can't be read
      // that way: the whole artifact decides.
    }
  }
  const directory = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "hot-updater-ipa-devices-"),
  );
  try {
    const file = path.join(directory, "App.ipa");
    await downloadNativeBuild(storage, build, file);
    try {
      return await readIpaInstallInfo(blobSource(await fs.openAsBlob(file)));
    } catch (error) {
      if (error instanceof NativeArtifactError) return null;
      throw error;
    }
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
};

/**
 * Whether a found `.ipa` installs on the registry's devices, for a run that
 * would reuse it: null for any other artifact, and for one that lists no
 * devices. `apple` reads Apple's devices only when the `.ipa` lacks one.
 */
export const readIosDeviceCoverage = async (
  {
    core,
    storage,
  }: {
    readonly core: Pick<HotUpdaterCoreApi, "listIosDevices">;
    readonly storage: StorageAdapter;
  },
  build: NativeBuildRow,
  apple: () => Promise<AppleDeviceState>,
  now = Date.now(),
): Promise<IosDeviceCoverage | null> => {
  if (
    build.artifact_kind !== "ipa" ||
    (build.export_method !== null &&
      build.export_method !== "ad-hoc" &&
      build.export_method !== "development")
  ) {
    return null;
  }
  const info = await readStoredIpaInstallInfo(storage, build);
  const devices = [
    ...(await listAll(core, "registered")),
    ...(await listAll(core, "approved")),
  ];
  return iosDeviceCoverage({ info, devices, apple, now });
};

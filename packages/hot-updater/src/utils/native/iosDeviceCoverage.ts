import fs from "fs";
import os from "os";
import path from "path";

import type {
  HotUpdaterCoreApi,
  IosDeviceRow,
  NativeBuildRow,
  StorageAdapter,
} from "@hot-updater/plugin-core";
import {
  blobSource,
  httpRangeSource,
  type IpaInstallInfo,
  NativeArtifactError,
  readIpaInstallInfo,
} from "@hot-updater/protocol/native-artifact";

import {
  downloadNativeBuild,
  resolveNativeBuildDownloadUrl,
} from "./downloadNativeBuild";

/**
 * Whether a registered ad hoc `.ipa` still installs on the device registry's
 * devices, as `native-build find --json` reports it in `iosDevices`.
 */
export interface IosDeviceCoverage {
  /** Whether a run can reuse the build rather than build again. */
  readonly reusable: boolean;
  /**
   * Why it can't: approved devices a new build would add (`missing`), an
   * expired profile, or a profile that can't be read. Null when it can.
   */
  readonly reason: "missing" | "expired" | "unreadable" | null;
  /** The devices, by name, a new build would add. */
  readonly missing: readonly string[];
  /**
   * The devices, by name, the `.ipa` lacks that its build already had the
   * chance to add: Apple hasn't enabled them, or the scheme can't add them.
   * Building again wouldn't add them, so they never ask for a build.
   */
  readonly waiting: readonly string[];
}

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
 * What a build's `.ipa` says of its devices, recomputed from the artifact
 * each time, never stored: null for an `.ipa` that lists no devices, which
 * the registry has no part in. A device the `.ipa` lacks asks for a build
 * only when it was approved or registered after the build: the build before
 * had the chance to add it, so building again for it would build again
 * forever.
 */
export const iosDeviceCoverage = ({
  build,
  info,
  devices,
  now,
}: {
  readonly build: Pick<NativeBuildRow, "created_at_ms">;
  /** The `.ipa`'s install info, or null when its profile can't be read. */
  readonly info: IpaInstallInfo | null;
  /** The registry's approved and registered devices. */
  readonly devices: readonly IosDeviceRow[];
  readonly now: number;
}): IosDeviceCoverage | null => {
  if (info === null) {
    return { reusable: false, reason: "unreadable", missing: [], waiting: [] };
  }
  if (info.distribution !== "ad-hoc" && info.distribution !== "development") {
    return null;
  }
  if (info.expiresAtMs !== null && info.expiresAtMs <= now) {
    return { reusable: false, reason: "expired", missing: [], waiting: [] };
  }
  const listed = new Set(info.devices);
  const lacking = devices.filter(({ udid }) => !listed.has(udid));
  const since = (device: IosDeviceRow) =>
    Math.max(device.approved_at_ms ?? 0, device.registered_at_ms ?? 0);
  const missing = lacking
    .filter((device) => since(device) > build.created_at_ms)
    .map(({ name }) => name);
  const waiting = lacking
    .filter((device) => since(device) <= build.created_at_ms)
    .map(({ name }) => name);
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
  const readOrNull = async (read: () => Promise<IpaInstallInfo>) => {
    try {
      return await read();
    } catch (error) {
      if (error instanceof NativeArtifactError) return null;
      throw error;
    }
  };
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
    return await readOrNull(async () =>
      readIpaInstallInfo(blobSource(await fs.openAsBlob(file))),
    );
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
};

/**
 * Whether a found `.ipa` installs on the registry's devices, for a run that
 * would reuse it: null for any other artifact, and for one that lists no
 * devices.
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
  return iosDeviceCoverage({ build, info, devices, now });
};

import type {
  HotUpdaterCoreApi,
  IosDeviceRow,
  NativeBuildRow,
  StorageAdapter,
} from "@hot-updater/plugin-core";
import {
  type ByteSource,
  type IpaInstallInfo,
  normalizeIosUdid,
  readIpaInstallInfo,
} from "@hot-updater/protocol/native-artifact";

import {
  NATIVE_BUILD_DOWNLOAD_TOKEN_PARAM,
  NATIVE_BUILD_INSTALL_LINK_TTL_MS,
  nativeBuildDownloadPath,
  nativeBuildManifestPath,
} from "../native-builds";
import { listIosDevices } from "./iosDevices";
import {
  issueNativeBuildDownloadLink,
  type NativeBuildDownloadLinkResult,
  refuseNativeBuildDownloadToken,
} from "./nativeBuildDownloadLink";
import { nativeBuildArtifactUrl } from "./nativeBuilds";
import { escapePlistText } from "./plistText";
import { publicConsoleBase } from "./publicConsoleBase";

const KiB = 1024;
const MiB = 1024 * KiB;
/**
 * What one request asks for at least: a zip entry's local header and, for
 * something the size of a profile, its data, so reading one takes one request.
 */
const READ_AHEAD_BYTES = 64 * KiB;
/** How many requests' bytes stay at hand: the archive's tail, and its entries. */
const KEPT_BLOCKS = 4;
/** The most one IPA's reading downloads: a directory and a few small files. */
const MAX_BYTES = 16 * MiB;
/** The most requests one IPA's reading makes, past a dozen extensions' profiles. */
const MAX_REQUESTS = 24;
const REQUEST_TIMEOUT_MS = 15_000;

/** Why a remote artifact can't be read in parts. */
export class RangeSourceError extends Error {
  override readonly name = "RangeSourceError";
}

/**
 * The bytes of `url` by HTTP Range requests, without ever downloading the
 * file: a server that answers a Range request with the whole file (200) is
 * cut off at once, as is one that sends more than it was asked for. Reading
 * stops at `MAX_BYTES` and `MAX_REQUESTS`.
 */
export const httpRangeSource = ({
  url,
  size,
  fetch = globalThis.fetch,
}: {
  readonly url: string;
  /** The artifact's length, as its build's row records it. */
  readonly size: number;
  readonly fetch?: typeof globalThis.fetch;
}): ByteSource => {
  const blocks: { readonly start: number; readonly bytes: Uint8Array }[] = [];
  let requests = 0;
  let downloaded = 0;

  const request = async (start: number, end: number): Promise<Uint8Array> => {
    if (requests === MAX_REQUESTS) {
      throw new RangeSourceError(
        "Reading the artifact took too many requests.",
      );
    }
    const length = end - start;
    if (downloaded + length > MAX_BYTES) {
      throw new RangeSourceError(
        "Reading the artifact would download too much.",
      );
    }
    requests += 1;
    const response = await fetch(url, {
      headers: {
        range: `bytes=${start}-${end - 1}`,
        "accept-encoding": "identity",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const contentRange = /^bytes (\d+)-(\d+)\/(\d+|\*)$/u.exec(
      response.headers.get("content-range") ?? "",
    );
    if (
      response.status !== 206 ||
      Number(contentRange?.[1]) !== start ||
      Number(contentRange?.[2]) !== end - 1 ||
      (contentRange?.[3] !== "*" && Number(contentRange?.[3]) !== size) ||
      response.body === null
    ) {
      await response.body?.cancel().catch(() => {});
      throw new RangeSourceError(
        `The storage answered ${response.status} to a Range request.`,
      );
    }
    const bytes = new Uint8Array(length);
    const reader = response.body.getReader();
    let written = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (written + value.byteLength > length) {
          throw new RangeSourceError(
            "The storage sent more than it was asked.",
          );
        }
        bytes.set(value, written);
        written += value.byteLength;
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    if (written !== length) {
      throw new RangeSourceError("The storage sent less than it was asked.");
    }
    downloaded += length;
    return bytes;
  };

  return {
    size,
    async read(offset, length) {
      const end = Math.min(size, offset + length);
      if (offset >= end) return new Uint8Array(0);
      for (const block of blocks) {
        if (block.start <= offset && end <= block.start + block.bytes.length) {
          return block.bytes.subarray(offset - block.start, end - block.start);
        }
      }
      const blockEnd = Math.min(size, Math.max(end, offset + READ_AHEAD_BYTES));
      const bytes = await request(offset, blockEnd);
      blocks.push({ start: offset, bytes });
      // The first block is the archive's tail, which holds its directory.
      if (blocks.length > KEPT_BLOCKS) blocks.splice(1, 1);
      return bytes.subarray(0, end - offset);
    },
  };
};

/**
 * What an IPA in storage installs as, or null when that can't be read in parts:
 * a storage with no HTTPS download URL, one that ignores Range requests, or an
 * artifact that isn't what it should be. It reads only the storage, and never
 * logs the URL, which may be signed.
 */
export const readNativeBuildInstallInfo = async (
  build: Pick<
    NativeBuildRow,
    "artifact_kind" | "artifact_storage_uri" | "byte_size"
  >,
  storage: StorageAdapter,
  fetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<IpaInstallInfo | null> => {
  if (build.artifact_kind !== "ipa") return null;
  try {
    const url = await nativeBuildArtifactUrl(build, storage);
    if (url === null || new URL(url).protocol !== "https:") return null;
    return await readIpaInstallInfo(
      httpRangeSource({ url, size: build.byte_size, fetch }),
    );
  } catch (error) {
    console.warn(
      `Installation details unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
};

export type NativeBuildInstallEligibility =
  /** The IPA can't be read in parts, so nothing can be said or installed. */
  | { readonly status: "unavailable" }
  /** An App Store export, which installs through TestFlight only. */
  | { readonly status: "store" }
  | { readonly status: "expired"; readonly expiresAt: string }
  | {
      readonly status: "installable";
      /** Whether the IPA lists the device: `unknown` without a UDID to look up. */
      readonly device: "unknown" | "included" | "not-included";
      /**
       * The registry's row of a device the IPA doesn't list, or null when the
       * registry doesn't know it: read only then.
       */
      readonly registry: IosDeviceRow | null;
      /**
       * A newer build of this app on this channel whose IPA lists the device,
       * which `registry.build_id` names, or null. The row keeps one build per
       * device, the newest of any ad hoc scheme the CLI checked, so the build
       * it names may be a sandbox's or another app's.
       */
      readonly newerBuild: string | null;
      /**
       * Whether the viewer approves devices, which decides the next step under
       * Apple's refusal: asked only when `registry` carries one, else false.
       */
      readonly canApprove: boolean;
      readonly expiresAt: string | null;
      /** The token of the Install button's manifest and download. */
      readonly link: NativeBuildDownloadLinkResult;
    };

const isExpired = ({ expiresAtMs }: IpaInstallInfo, now: number) =>
  expiresAtMs !== null && expiresAtMs <= now;

/**
 * The build a registered device's row names, when it is newer than `build`,
 * of the same app (bundle ID, read from its IPA, and sandbox or not), on the
 * same channel, or for a sandbox build, of the same sandbox scope on any
 * channel, ad hoc, unexpired, and its IPA lists the device; null
 * otherwise, and for a build gone or unreadable. Its row is read only for a
 * registered device whose row names a newer build, and its IPA only when the
 * row matches.
 */
const newerBuildListing = async (
  build: NativeBuildRow,
  info: IpaInstallInfo,
  device: IosDeviceRow,
  key: string,
  {
    core,
    storage,
    fetch,
    now,
  }: {
    readonly core: Pick<HotUpdaterCoreApi, "getNativeBuild">;
    readonly storage: StorageAdapter;
    readonly fetch: typeof globalThis.fetch;
    readonly now: number;
  },
): Promise<string | null> => {
  const id = device.build_id;
  if (device.status !== "registered" || id === null || id <= build.id) {
    return null;
  }
  const newer = await core.getNativeBuild(id).catch(() => null);
  if (
    newer === null ||
    newer.artifact_kind !== "ipa" ||
    newer.platform !== build.platform ||
    newer.is_sandbox !== build.is_sandbox ||
    // A sandbox build's replacement may embed another pull request's
    // channel: its scope, which names none, says it is the same app.
    (build.is_sandbox
      ? newer.scope_key !== build.scope_key
      : newer.channel_id !== build.channel_id) ||
    // Null on an IPA registered before it was recorded: its profile decides.
    (newer.export_method !== null && newer.export_method !== "ad-hoc")
  ) {
    return null;
  }
  const listing = await readNativeBuildInstallInfo(newer, storage, fetch);
  return listing !== null &&
    listing.bundleId === info.bundleId &&
    listing.distribution === "ad-hoc" &&
    listing.devices.includes(key) &&
    !isExpired(listing, now)
    ? id
    : null;
};

/**
 * What an iPhone can do with a build, for a caller the Console already let in:
 * one read of the build's row, and the IPA's few parts from storage. App Store
 * Connect isn't asked, so this says what the IPA's bytes allow, which is what
 * iOS enforces; registering a device changes nothing until a new IPA has it.
 */
export const checkNativeBuildInstall = async (
  id: string,
  udid: string | undefined,
  {
    core,
    storage,
  }: {
    readonly core: Pick<HotUpdaterCoreApi, "getNativeBuild" | "findIosDevice">;
    readonly storage: StorageAdapter;
  },
  {
    request,
    now = Date.now(),
    fetch = globalThis.fetch,
    canApprove = async () => false,
  }: {
    readonly request?: Request;
    readonly now?: number;
    readonly fetch?: typeof globalThis.fetch;
    /** Whether the viewer approves devices, asked only under Apple's refusal. */
    readonly canApprove?: () => Promise<boolean>;
  } = {},
): Promise<NativeBuildInstallEligibility> => {
  const build = await core.getNativeBuild(id);
  if (build === null) return { status: "unavailable" };
  const info = await readNativeBuildInstallInfo(build, storage, fetch);
  if (info === null) return { status: "unavailable" };
  if (info.distribution === "store") return { status: "store" };
  const expiresAt =
    info.expiresAtMs === null ? null : new Date(info.expiresAtMs).toISOString();
  if (expiresAt !== null && isExpired(info, now)) {
    return { status: "expired", expiresAt };
  }
  const key = udid === undefined ? null : normalizeIosUdid(udid);
  const device =
    key === null
      ? "unknown"
      : info.distribution === "enterprise" || info.devices.includes(key)
        ? "included"
        : "not-included";
  const registry =
    device === "not-included" && key !== null
      ? await core.findIosDevice(key)
      : null;
  return {
    status: "installable",
    device,
    registry,
    newerBuild:
      registry === null || key === null
        ? null
        : await newerBuildListing(build, info, registry, key, {
            core,
            storage,
            fetch,
            now,
          }),
    canApprove: registry?.apple_error == null ? false : await canApprove(),
    expiresAt,
    link: await issueNativeBuildDownloadLink(
      id,
      request,
      now,
      NATIVE_BUILD_INSTALL_LINK_TTL_MS,
    ),
  };
};

const installRefusal = (status: number, message: string) =>
  new Response(message, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
    },
  });

/**
 * The manifest iOS installs a build from, at `/_hot-updater/native-builds/
 * <id>/manifest.plist?t=<download token>`. The installer has no session, so the
 * token is all it answers to, and it is checked before anything is read. It
 * mints nothing: the manifest's IPA URL carries the same token.
 *
 * - 403: no token, or one that isn't this build's, or has expired;
 * - 404: no such build, or not an IPA;
 * - 409: an IPA that can't install this way (App Store export, expired profile);
 * - 503: the IPA can't be read in parts.
 */
export const serveNativeBuildManifest = async (
  request: Request,
  id: string,
  loadDeps: () => Promise<{
    readonly core: Pick<HotUpdaterCoreApi, "getNativeBuild">;
    readonly storage: StorageAdapter;
  }>,
  fetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<Response> => {
  const token = new URL(request.url).searchParams.get(
    NATIVE_BUILD_DOWNLOAD_TOKEN_PARAM,
  );
  if (token === null) {
    return installRefusal(
      403,
      "This install link isn't valid. Open the build's Console page for a new one.",
    );
  }
  const refused = await refuseNativeBuildDownloadToken(request, id, token);
  if (refused !== undefined) return refused;

  const { core, storage } = await loadDeps();
  const build = await core.getNativeBuild(id);
  if (build === null || build.artifact_kind !== "ipa") {
    return installRefusal(404, "This build has no IPA to install.");
  }
  const info = await readNativeBuildInstallInfo(build, storage, fetch);
  if (info === null) {
    return installRefusal(503, "Installation details unavailable.");
  }
  if (info.distribution === "store") {
    return installRefusal(
      409,
      build.is_sandbox
        ? "This IPA is an App Store export, which doesn't install from a link."
        : "This IPA is an App Store export, which installs through TestFlight.",
    );
  }
  if (isExpired(info, Date.now())) {
    return installRefusal(
      409,
      "This IPA's provisioning profile has expired. Rebuild it.",
    );
  }

  const base = publicConsoleBase(request, nativeBuildManifestPath(id));
  const ipaUrl = `${base}${nativeBuildDownloadPath(id)}?${NATIVE_BUILD_DOWNLOAD_TOKEN_PARAM}=${encodeURIComponent(token)}`;
  const manifest = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>items</key>
  <array>
    <dict>
      <key>assets</key>
      <array>
        <dict>
          <key>kind</key>
          <string>software-package</string>
          <key>url</key>
          <string>${escapePlistText(ipaUrl)}</string>
        </dict>
      </array>
      <key>metadata</key>
      <dict>
        <key>bundle-identifier</key>
        <string>${escapePlistText(info.bundleId)}</string>
        <key>bundle-version</key>
        <string>${escapePlistText(info.bundleVersion)}</string>
        <key>kind</key>
        <string>software</string>
        <key>title</key>
        <string>${escapePlistText(info.title)}</string>
      </dict>
    </dict>
  </array>
</dict>
</plist>
`;
  return new Response(manifest, {
    headers: {
      "cache-control": "private, no-store",
      "content-type": "text/xml; charset=utf-8",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
};

/** One device an ad hoc IPA lists, with the registry's name when it has one. */
export interface NativeBuildIpaDevice {
  readonly udid: string;
  readonly name: string | null;
}

export type NativeBuildIpaDevices =
  /** The IPA can't be read in parts. */
  | { readonly status: "unavailable" }
  /** An App Store export or an enterprise build, which list no devices. */
  | { readonly status: "store" | "enterprise" }
  | { readonly status: "listed"; readonly devices: NativeBuildIpaDevice[] };

/**
 * The devices an IPA's profile lists, read from storage as the install check
 * reads it, each named by the device registry when it knows the UDID. The IPA
 * decides: the registry only names what it lists. One build read, the IPA's
 * few parts, and the registry a page at a time.
 */
export const readNativeBuildIpaDevices = async (
  id: string,
  {
    core,
    storage,
  }: {
    readonly core: Pick<HotUpdaterCoreApi, "getNativeBuild" | "listIosDevices">;
    readonly storage: StorageAdapter;
  },
  fetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<NativeBuildIpaDevices> => {
  const build = await core.getNativeBuild(id);
  if (build === null) return { status: "unavailable" };
  const info = await readNativeBuildInstallInfo(build, storage, fetch);
  if (info === null) return { status: "unavailable" };
  if (info.distribution === "store" || info.distribution === "enterprise") {
    return { status: info.distribution };
  }
  const names = new Map(
    info.devices.length === 0
      ? []
      : (await listIosDevices(core)).map((row) => [row.udid, row.name]),
  );
  return {
    status: "listed",
    devices: info.devices.map((udid) => ({
      udid,
      name: names.get(udid) ?? null,
    })),
  };
};

import { normalizeIosUdid } from "@hot-updater/protocol/native-artifact";

import {
  type AppStoreConnectApiKey,
  AppStoreConnectError,
  type AppStoreConnectRequest,
  createAppStoreConnectRequest,
  readPrivateKey,
  retrying,
} from "../uploadToTestFlight";
import { isProgramLicenseAgreementError } from "./programLicenseAgreement";

const API_URL = "https://api.appstoreconnect.apple.com";
const DEVICE_FIELDS = "name,udid,status,deviceClass";
const PAGE_SIZE = 200;
/** More pages than an account's yearly limit of devices can fill. */
const MAX_PAGES = 50;

/** A device an Apple account has registered. */
export interface AscDevice {
  readonly id: string;
  readonly name: string;
  readonly udid: string;
  /** `ENABLED`, or `DISABLED`, which no new profile includes. */
  readonly status: string;
  /** `IPHONE`, `IPAD`, and so on. */
  readonly deviceClass: string | null;
}

interface DevicePage {
  readonly data: {
    readonly id: string;
    readonly attributes?: {
      readonly name?: string;
      readonly udid?: string;
      readonly status?: string;
      readonly deviceClass?: string;
    };
  }[];
  readonly links?: { readonly next?: string };
}

const deviceOf = ({
  id,
  attributes,
}: DevicePage["data"][number]): AscDevice => ({
  id,
  name: attributes?.name ?? "",
  udid: attributes?.udid ?? "",
  status: attributes?.status ?? "",
  deviceClass: attributes?.deviceClass ?? null,
});

/**
 * A 403 from this API means something else than an upload's. A key's role
 * decides it, and only the person who owns the key can change that, so no key
 * is issued here.
 */
const describingAccess = async <T>(run: () => Promise<T>): Promise<T> => {
  try {
    return await run();
  } catch (error) {
    const cause = error instanceof Error ? error.cause : undefined;
    if (
      cause instanceof AppStoreConnectError &&
      cause.status === 403 &&
      !isProgramLicenseAgreementError(cause.errors)
    ) {
      throw new Error(
        "App Store Connect doesn't let this API key register devices.\nUse a key with the Admin role: npx hot-updater apple login",
        { cause },
      );
    }
    throw error;
  }
};

const readPages = async (
  request: AppStoreConnectRequest,
  firstPath: string,
): Promise<AscDevice[]> => {
  const devices: AscDevice[] = [];
  let pathname: string | undefined = firstPath;
  for (let page = 0; pathname !== undefined; page += 1) {
    if (page === MAX_PAGES) {
      throw new Error("App Store Connect's device list didn't end.");
    }
    const path: string = pathname;
    const answer = await retrying(() =>
      request<DevicePage>("Reading App Store Connect's devices", "GET", path),
    );
    devices.push(...answer.data.map(deviceOf));
    const next: string | undefined = answer.links?.next;
    if (next !== undefined && !next.startsWith(`${API_URL}/`)) {
      throw new Error("App Store Connect's next page is on another host.");
    }
    pathname = next?.slice(API_URL.length);
  }
  return devices;
};

const listPath = (filter: Record<string, string> = {}) =>
  `/v1/devices?${new URLSearchParams({
    "filter[platform]": "IOS",
    ...filter,
    "fields[devices]": DEVICE_FIELDS,
    limit: String(PAGE_SIZE),
  })}`;

/** Every iPhone and iPad the Apple account has registered. */
export const listAscDevices = async ({
  apiKey,
  fetch = globalThis.fetch,
}: {
  apiKey: AppStoreConnectApiKey;
  fetch?: typeof globalThis.fetch;
}): Promise<AscDevice[]> => {
  const privateKey = await readPrivateKey(apiKey.keyPath);
  const request = createAppStoreConnectRequest({ apiKey, privateKey, fetch });
  return describingAccess(() => readPages(request, listPath()));
};

/** What adding one device came to. */
export type AscDeviceOutcome =
  | {
      readonly udid: string;
      readonly outcome: "registered" | "already-registered" | "disabled";
      readonly device: AscDevice;
    }
  | {
      readonly udid: string;
      readonly outcome: "refused";
      /** Apple's own words. */
      readonly reason: string;
      /** Whether the refusal is the account's yearly limit of devices. */
      readonly limitReached: boolean;
    };

const keyOf = (udid: string) => normalizeIosUdid(udid) ?? udid.toLowerCase();

const findDevices = async (
  request: AppStoreConnectRequest,
  udids: readonly string[],
) =>
  new Map(
    (
      await readPages(request, listPath({ "filter[udid]": udids.join(",") }))
    ).map((device) => [keyOf(device.udid), device]),
  );

/**
 * Registers devices with the Apple account, each at most once: a device that
 * is already there succeeds and changes nothing, so running it again is safe,
 * and so is a race with another run, which App Store Connect answers with 409.
 * A disabled device stays disabled, since its slot is already spent and someone
 * chose to disable it. It only registers: Xcode adds a registered device to the
 * profile at the next export, so an `.ipa` signed before never gains it.
 */
export const addAscDevices = async ({
  devices,
  apiKey,
  fetch = globalThis.fetch,
}: {
  devices: readonly { readonly udid: string; readonly name: string }[];
  apiKey: AppStoreConnectApiKey;
  fetch?: typeof globalThis.fetch;
}): Promise<AscDeviceOutcome[]> => {
  const privateKey = await readPrivateKey(apiKey.keyPath);
  const request = createAppStoreConnectRequest({ apiKey, privateKey, fetch });
  return describingAccess(async () => {
    const found = await findDevices(
      request,
      devices.map(({ udid }) => udid),
    );
    const outcomes: AscDeviceOutcome[] = [];
    for (const { udid, name } of devices) {
      const existing = found.get(keyOf(udid));
      if (existing !== undefined) {
        outcomes.push({
          udid,
          outcome:
            existing.status === "DISABLED" ? "disabled" : "already-registered",
          device: existing,
        });
        continue;
      }
      try {
        const { data } = await retrying(() =>
          request<{ data: DevicePage["data"][number] }>(
            `Registering ${udid}`,
            "POST",
            "/v1/devices",
            {
              data: {
                type: "devices",
                attributes: { name, platform: "IOS", udid },
              },
            },
          ),
        );
        outcomes.push({ udid, outcome: "registered", device: deviceOf(data) });
      } catch (error) {
        if (!(error instanceof AppStoreConnectError) || error.status !== 409) {
          throw error;
        }
        const raced = (await findDevices(request, [udid])).get(keyOf(udid));
        if (raced !== undefined) {
          outcomes.push({
            udid,
            outcome:
              raced.status === "DISABLED" ? "disabled" : "already-registered",
            device: raced,
          });
          continue;
        }
        const reason = error.errors
          .map(({ detail, title }) => detail ?? title)
          .filter(Boolean)
          .join(" ");
        outcomes.push({
          udid,
          outcome: "refused",
          reason: reason || "App Store Connect refused it.",
          limitReached: /maximum|limit/iu.test(reason),
        });
      }
    }
    return outcomes;
  });
};

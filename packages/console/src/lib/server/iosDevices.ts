import type {
  HotUpdaterCoreApi,
  IosDeviceRow,
  IosDeviceStatus,
} from "@hot-updater/plugin-core";

import type { ConsolePrincipal } from "../../index";
import {
  createDeviceProfileToken,
  DEVICE_PROFILE_TOKEN_TTL_MS,
  verifyDeviceReceipt,
} from "./deviceProfileToken";
import {
  CONSOLE_SECRET_ENV,
  readConsoleSecret,
} from "./nativeBuildDownloadLink";

/** A registry page: past an Apple account's yearly limit of devices. */
const PAGE = 200;

/** `ios_devices.name`'s bound in core's schema. */
const NAME_MAX_LENGTH = 100;

/** Who is looking at the iOS devices page, and what they may do. */
export interface IosDeviceViewer {
  /** The signed-in email, lower-cased. */
  readonly email: string;
  /**
   * Whether this person approves, renames, and removes devices: anyone on
   * the local Console, or the hosted Console's `console.deviceApprovers`.
   */
  readonly canApprove: boolean;
  /** Whether the hosted Console lists anyone who approves. */
  readonly approversConfigured: boolean;
}

const forbidden = (message: string) =>
  new Response(message, {
    status: 403,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });

/** Whether this is `hot-updater console`, the local runtime, by its mode. */
const isLocalConsole = async () => {
  const { default: localConsoleGuard } =
    await import("virtual:hot-updater-console/request-guard");
  return localConsoleGuard !== undefined;
};

/**
 * The viewer's rights over the registry. The local Console is recognized by
 * its mode, never by an email, so a hosted user named like the local one
 * gains nothing. A hosted approver is an email in `deviceApprovers`.
 */
export const iosDeviceViewer = async (
  principal: ConsolePrincipal,
  deviceApprovers: readonly string[],
): Promise<IosDeviceViewer> => {
  const email = principal.email.trim().toLowerCase();
  const local = await isLocalConsole();
  return {
    email,
    canApprove: local || deviceApprovers.includes(email),
    approversConfigured: local || deviceApprovers.length > 0,
  };
};

/** Refuses anyone but an approver, on the server, whatever the UI sent. */
export const requireDeviceApprover = (viewer: IosDeviceViewer) => {
  if (!viewer.canApprove) {
    throw forbidden("Only a device approver can do this.");
  }
};

/** Every registry row, newest first, or one status's. */
export const listIosDevices = async (
  core: Pick<HotUpdaterCoreApi, "listIosDevices">,
  status?: IosDeviceStatus,
): Promise<IosDeviceRow[]> => {
  const rows: IosDeviceRow[] = [];
  for (let after: string | undefined; ; ) {
    const page = await core.listIosDevices({
      order: "desc",
      limit: PAGE,
      ...(status === undefined ? {} : { status }),
      ...(after === undefined ? {} : { after }),
    });
    rows.push(...page);
    if (page.length < PAGE) return rows;
    after = page.at(-1)!.id;
  }
};

/** A device name as the registry stores it, or a refusal. */
export const deviceName = (name: unknown): string => {
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (trimmed.length === 0 || trimmed.length > NAME_MAX_LENGTH) {
    throw new TypeError(
      `Name the device in 1 to ${NAME_MAX_LENGTH} characters.`,
    );
  }
  return trimmed;
};

/** The name a device gets before anyone types one: the person's, then "iPhone". */
export const defaultDeviceName = (principal: ConsolePrincipal) => {
  const owner =
    principal.name?.trim() || principal.email.split("@")[0]?.trim() || "";
  return owner === ""
    ? "iPhone"
    : `${owner}'s iPhone`.slice(0, NAME_MAX_LENGTH);
};

/**
 * Whether an iPhone can register through this Console: not through the local
 * one, which an iPhone can't reach, nor without the secret that signs links.
 */
export const deviceRegistration = async (
  request: Request,
): Promise<"ready" | "local-console" | "no-secret"> => {
  if (await isLocalConsole()) return "local-console";
  return readConsoleSecret(request) === undefined ? "no-secret" : "ready";
};

export type DeviceProfileLinkResult =
  | {
      readonly status: "issued";
      /** The `t` of the profile route. */
      readonly token: string;
      readonly expiresAt: string;
    }
  /** An iPhone can't reach a Console on this computer. */
  | { readonly status: "local-console" }
  | { readonly status: "no-secret"; readonly secretName: string };

/**
 * A new capability for this person's iPhone profile: `register` saves the
 * iPhone as requested under `name`, `identify` only tells build `buildId`'s
 * page which iPhone it is. It reads and stores nothing.
 */
export const issueDeviceProfileLink = async (
  request: Request,
  viewer: IosDeviceViewer,
  input:
    | { readonly mode: "register"; readonly name: string }
    | { readonly mode: "identify"; readonly buildId: string },
  now: number = Date.now(),
): Promise<DeviceProfileLinkResult> => {
  if (await isLocalConsole()) return { status: "local-console" };
  const secret = readConsoleSecret(request);
  if (secret === undefined) {
    return { status: "no-secret", secretName: CONSOLE_SECRET_ENV };
  }
  const token = await createDeviceProfileToken(
    secret,
    input.mode === "register"
      ? { m: "register", e: viewer.email, n: deviceName(input.name) }
      : { m: "identify", e: viewer.email, b: input.buildId },
    now,
  );
  return {
    status: "issued",
    token,
    expiresAt: new Date(now + DEVICE_PROFILE_TOKEN_TTL_MS).toISOString(),
  };
};

/**
 * Requests the iPhone a receipt names, for the person whose profile made it:
 * the UDID comes from the receipt alone. Another person's receipt, an expired
 * one, or none, is refused.
 */
export const requestIosDeviceAccess = async (
  request: Request,
  core: Pick<HotUpdaterCoreApi, "requestIosDevice">,
  viewer: IosDeviceViewer,
  input: { readonly receipt: string; readonly name: string },
) => {
  const secret = readConsoleSecret(request);
  const receipt =
    secret === undefined
      ? "invalid"
      : await verifyDeviceReceipt(secret, input.receipt);
  if (receipt === "expired") {
    throw forbidden("Check this iPhone again: its check has expired.");
  }
  if (receipt === "invalid" || receipt.e !== viewer.email) {
    throw forbidden("Check this iPhone again from this account.");
  }
  return core.requestIosDevice({
    udid: receipt.u,
    name: deviceName(input.name),
    requestedBy: viewer.email,
  });
};

/**
 * Removes a device from the registry, as read now: an approver removes any,
 * and the person who asked withdraws their own while it is still requested.
 * Null when it is gone already.
 */
export const removeIosDevice = async (
  core: Pick<HotUpdaterCoreApi, "findIosDevice" | "deleteIosDevice">,
  viewer: IosDeviceViewer,
  udid: string,
): Promise<IosDeviceRow | null> => {
  const device = await core.findIosDevice(udid);
  if (device === null) return null;
  if (viewer.canApprove) return core.deleteIosDevice(device.id);
  if (device.status !== "pending" || device.requested_by !== viewer.email) {
    throw forbidden("Only a device approver can remove this device.");
  }
  // Only while it is still this person's request: an approval meanwhile
  // makes it an approver's to remove.
  const withdrawn = await core.deleteIosDevice(device.id, {
    status: "pending",
    requestedBy: viewer.email,
  });
  if (withdrawn === null && (await core.findIosDevice(udid)) !== null) {
    throw forbidden("It was approved meanwhile. A device approver removes it.");
  }
  return withdrawn;
};

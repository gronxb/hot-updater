import type { IosDeviceRow, IosDeviceStatus } from "@hot-updater/plugin-core";
import { createServerFn } from "@tanstack/react-start";

import { consoleAccess } from "./console-access";

const STATUSES: readonly IosDeviceStatus[] = [
  "pending",
  "approved",
  "registered",
];

const record = (input: unknown): Record<string, unknown> => {
  if (typeof input !== "object" || input === null) {
    throw new TypeError("Invalid input.");
  }
  return input as Record<string, unknown>;
};

const text = (input: unknown, field: string, max = 2048): string => {
  const value = record(input)[field];
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new TypeError(`Invalid ${field}.`);
  }
  return value;
};

/**
 * The registry over the Console's own assembly, with the signed-in viewer's
 * rights: the access check runs first, in the middleware and again here.
 */
const registry = async () => {
  const [{ getRequest }, { prepareConfig }, { requireConsoleAccess }, devices] =
    await Promise.all([
      import("@tanstack/react-start/server"),
      import("./server/config.server"),
      import("./server/auth.server"),
      import("./server/iosDevices"),
    ]);
  const request = getRequest();
  const [{ core, config }, principal] = await Promise.all([
    prepareConfig(request),
    requireConsoleAccess(request),
  ]);
  const viewer = await devices.iosDeviceViewer(
    principal,
    config.deviceApprovers,
  );
  return { request, core, principal, viewer, devices };
};

export interface IosDevicesView {
  readonly devices: IosDeviceRow[];
  readonly viewer: {
    readonly email: string;
    readonly canApprove: boolean;
    readonly approversConfigured: boolean;
  };
  /** The name a new iPhone gets until its owner types one. */
  readonly defaultName: string;
  /** Whether iPhones can register through this Console. */
  readonly registration: "ready" | "local-console" | "no-secret";
  /** The secret that signs iPhone links, which `no-secret` asks to set. */
  readonly secretName: string;
}

/** The registry, or one status of it, with what the viewer may do. */
export const getIosDevices = createServerFn({ method: "GET" })
  .middleware([consoleAccess])
  .validator((input: { status?: IosDeviceStatus } | undefined) => {
    const status = input?.status;
    if (status !== undefined && !STATUSES.includes(status)) {
      throw new TypeError("Invalid status.");
    }
    return status === undefined ? {} : { status };
  })
  .handler(async ({ data }): Promise<IosDevicesView> => {
    const [
      { request, core, principal, viewer, devices },
      { CONSOLE_SECRET_ENV },
    ] = await Promise.all([
      registry(),
      import("./server/nativeBuildDownloadLink"),
    ]);
    return {
      devices: await devices.listIosDevices(core, data.status),
      viewer,
      defaultName: devices.defaultDeviceName(principal),
      registration: await devices.deviceRegistration(request),
      secretName: CONSOLE_SECRET_ENV,
    };
  });

/**
 * The registry's row of one UDID, or null: what an iPhone back from its
 * profile reads of itself. One keyed read, whatever the list's filter. A
 * POST, as the install check is, so the UDID stays out of the URL.
 */
export const getIosDevice = createServerFn({ method: "POST" })
  .middleware([consoleAccess])
  .validator((input: unknown) => ({ udid: text(input, "udid", 64) }))
  .handler(async ({ data }): Promise<IosDeviceRow | null> => {
    const [{ core }, { normalizeIosUdid }] = await Promise.all([
      registry(),
      import("@hot-updater/protocol/native-artifact"),
    ]);
    const udid = normalizeIosUdid(data.udid);
    return udid === null ? null : core.findIosDevice(udid);
  });

/**
 * A new link to the profile that reads this iPhone's UDID: `register` saves
 * it as requested under `name`, `identify` tells build `buildId`'s page which
 * iPhone it is. A POST, since it signs the link.
 */
export const createIosDeviceProfileLink = createServerFn({ method: "POST" })
  .middleware([consoleAccess])
  .validator((input: unknown) => {
    const mode = record(input).mode;
    if (mode === "register") {
      return { mode, name: text(input, "name", 100) } as const;
    }
    if (mode === "identify") {
      return { mode, buildId: text(input, "buildId", 36) } as const;
    }
    throw new TypeError("Invalid mode.");
  })
  .handler(async ({ data }) => {
    const { request, viewer, devices } = await registry();
    return devices.issueDeviceProfileLink(request, viewer, data);
  });

/** Approves a requested device, with its name: approvers only. */
export const approveIosDevice = createServerFn({ method: "POST" })
  .middleware([consoleAccess])
  .validator((input: unknown) => ({
    id: text(input, "id", 36),
    name: text(input, "name", 100),
  }))
  .handler(async ({ data }) => {
    const { core, viewer, devices } = await registry();
    devices.requireDeviceApprover(viewer);
    return core.approveIosDevice(data.id, {
      name: devices.deviceName(data.name),
      approvedBy: viewer.email,
    });
  });

/** Renames a device in the registry: approvers only. */
export const renameIosDevice = createServerFn({ method: "POST" })
  .middleware([consoleAccess])
  .validator((input: unknown) => ({
    id: text(input, "id", 36),
    name: text(input, "name", 100),
  }))
  .handler(async ({ data }) => {
    const { core, viewer, devices } = await registry();
    devices.requireDeviceApprover(viewer);
    return core.renameIosDevice(data.id, devices.deviceName(data.name));
  });

/**
 * Removes a device from the registry: an approver any, the person who asked
 * their own requested one. Apple keeps it.
 */
export const removeIosDevice = createServerFn({ method: "POST" })
  .middleware([consoleAccess])
  .validator((input: unknown) => ({ udid: text(input, "udid", 40) }))
  .handler(async ({ data }) => {
    const { core, viewer, devices } = await registry();
    return devices.removeIosDevice(core, viewer, data.udid);
  });

/**
 * The devices an ad hoc build's IPA lists, read from its profile in storage,
 * each with its registry name when the registry knows it: one row read, the
 * IPA's few parts, and one page of the registry.
 */
export const getNativeBuildIpaDevices = createServerFn({ method: "GET" })
  .middleware([consoleAccess])
  .validator((input: { id: string }) => ({ id: text(input, "id", 36) }))
  .handler(async ({ data }) => {
    const [{ prepareConfig }, { readNativeBuildIpaDevices }] =
      await Promise.all([
        import("./server/config.server"),
        import("./server/nativeBuildInstall"),
      ]);
    return readNativeBuildIpaDevices(data.id, await prepareConfig());
  });

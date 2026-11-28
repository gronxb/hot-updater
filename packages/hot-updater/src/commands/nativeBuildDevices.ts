import {
  type AscDevice,
  type AscDeviceOutcome,
  addAscDevices,
  findAscDevice,
  listAscDevices,
  updateAscDevice,
} from "@hot-updater/apple-helper";
import {
  type Credentials,
  getCwd,
  loadConfig,
  nonInteractiveReason,
  p,
  parseSecretReference,
  readLoadedHotUpdaterEnv,
  withCredentialResolver,
} from "@hot-updater/cli-tools";
import type { IosDeviceRow } from "@hot-updater/plugin-core";
import { normalizeIosUdid } from "@hot-updater/protocol/native-artifact";

import { ui } from "../utils/cli-ui";
import { type LoadedServer, loadServer } from "../utils/loadServer";
import { printBanner } from "../utils/printBanner";

export interface NativeBuildDevicesOptions {
  /** The `nativeBuild.ios` scheme whose key to use; without it, the only one. */
  readonly scheme?: string;
}

export interface NativeBuildDevicesAddOptions extends NativeBuildDevicesOptions {
  /** Without any, a terminal picks from the registry's requested devices. */
  readonly udid?: readonly string[];
  /** One label for every UDID, or one for each, in order. */
  readonly name?: readonly string[];
}

export interface NativeBuildDevicesRenameOptions extends NativeBuildDevicesOptions {
  readonly udid: string;
  readonly name: string;
}

export interface NativeBuildDevicesRemoveOptions extends NativeBuildDevicesOptions {
  readonly udid: string;
  /** Disables the device at Apple too, without asking. */
  readonly yes?: boolean;
}

/** A registry page: past the account's yearly limit, so one page holds every row. */
const PAGE = 200;

const DEVICES_URL =
  "https://developer.apple.com/account/resources/devices/list";

/**
 * The scheme whose App Store Connect API key speaks for the team: the named
 * one, or the only device scheme.
 */
const pickScheme = async (scheme: string | undefined) => {
  const config = await loadConfig({ platform: "ios", channel: "" });
  const schemes = config.nativeBuild.ios;
  if (scheme !== undefined) {
    const iosScheme = schemes[scheme];
    if (iosScheme === undefined) {
      throw new Error(
        `hot-updater.config.ts has no nativeBuild.ios scheme ${scheme}.\nPick one: ${Object.keys(schemes).join(", ") || "(none)"}`,
      );
    }
    return { config, scheme, iosScheme };
  }
  const devices = Object.entries(schemes).filter(
    ([, iosScheme]) => !iosScheme.simulator,
  );
  const [only] = devices;
  if (only === undefined || devices.length > 1) {
    throw new Error(
      devices.length === 0
        ? "hot-updater.config.ts has no nativeBuild.ios scheme that builds for a device.\nAdd one with signing.ascApiKey."
        : `Several nativeBuild.ios schemes build for a device: ${devices.map(([name]) => name).join(", ")}.\nPick one with --scheme.`,
    );
  }
  return { config, scheme: only[0], iosScheme: only[1] };
};

interface DevicesContext {
  readonly apiKey: Credentials["asc-api-key"];
  readonly scheme: string;
  /** The server the config describes: the device registry's database. */
  readonly server: LoadedServer;
}

/**
 * Runs `run` with the scheme's App Store Connect API key, which it never
 * issues, and the config's server, which it disposes afterwards. The server
 * loads first, so a database it can't reach fails before any Apple call.
 */
const withDevices = async <T>(
  schemeName: string | undefined,
  run: (context: DevicesContext) => Promise<T>,
): Promise<T> => {
  const { config, scheme, iosScheme } = await pickScheme(schemeName);
  const server = await loadServer(config);
  try {
    const cwd = getCwd();
    return await withCredentialResolver(
      async (credentials) =>
        run({
          apiKey: await credentials.resolve({
            kind: "asc-api-key",
            name: iosScheme.signing
              ? parseSecretReference(
                  iosScheme.signing.ascApiKey,
                  "signing.ascApiKey",
                )
              : "asc-api-key",
          }),
          scheme,
          server,
        }),
      {
        env: await readLoadedHotUpdaterEnv(cwd),
        secrets: config.secrets,
        cwd,
      },
    );
  } finally {
    await server.dispose();
  }
};

const fail = (error: unknown) => {
  p.log.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
};

const udidOrThrow = (value: string) => {
  const key = normalizeIosUdid(value);
  if (key === null) {
    throw new Error(
      `${value} isn't an iPhone's or iPad's UDID.\nCopy it from the Console's iOS devices page, or from Finder.`,
    );
  }
  return key;
};

/**
 * The devices to add, each UDID once, or a refusal before anything reaches
 * Apple: a typo would spend one of the account's yearly slots.
 */
const parseDevices = ({
  udid = [],
  name = [],
}: NativeBuildDevicesAddOptions) => {
  if (name.length !== 1 && name.length !== udid.length) {
    throw new Error(
      `${udid.length} --udid and ${name.length} --name don't pair up.\nPass one --name for all of them, or one for each.`,
    );
  }
  const seen = new Set<string>();
  return udid.flatMap((value, index) => {
    const key = udidOrThrow(value);
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ udid: value.trim(), name: name[index] ?? name[0]! }];
  });
};

/** Every registry row, oldest first, or only one status's. */
const listRegistry = async (
  server: LoadedServer,
  status?: IosDeviceRow["status"],
): Promise<IosDeviceRow[]> => {
  const rows: IosDeviceRow[] = [];
  for (let after: string | undefined; ; ) {
    const page = await server.core.listIosDevices({
      limit: PAGE,
      ...(status === undefined ? {} : { status }),
      ...(after === undefined ? {} : { after }),
    });
    rows.push(...page);
    if (page.length < PAGE) return rows;
    after = page.at(-1)!.id;
  }
};

const reportOutcome = (name: string, result: AscDeviceOutcome) => {
  switch (result.outcome) {
    case "registered":
      p.log.success(`Registered ${name} with Apple.`);
      return;
    case "already-registered":
      p.log.step(`${name} is already registered with Apple.`);
      return;
    case "disabled":
      p.log.error(
        `${name} is disabled in your Apple account, so no build can include it.\nEnable it at ${DEVICES_URL}`,
      );
      return;
    case "refused":
      p.log.error(
        result.limitReached
          ? `Apple refused ${name}: ${result.reason}\nTestFlight has no such limit: npx hot-updater testflight`
          : `Apple refused ${name}: ${result.reason}\nCheck the UDID, or the device list at ${DEVICES_URL}`,
      );
      return;
  }
};

/**
 * Approves a registry row and registers it with Apple, then records Apple's
 * answer over the row it approved. A row another account registered keeps its
 * record; Apple's answer is still printed.
 */
const approveAndRegister = async (
  { apiKey, server }: DevicesContext,
  row: IosDeviceRow,
  name: string,
): Promise<AscDeviceOutcome> => {
  const approved = await server.core.approveIosDevice(row.id, {
    approvedBy: null,
    ...(name === row.name ? {} : { name }),
  });
  if (approved === null) {
    throw new Error(`${row.name} left the registry. Nothing was registered.`);
  }
  // A terminal registers with the key it was given, whoever's account the
  // registry has; a registry with none takes this one, as a build would.
  await server.core.claimIosDeviceAccount(apiKey.issuerId);
  const [result] = await addAscDevices({
    devices: [{ udid: approved.udid, name: approved.name }],
    apiKey,
  });
  await server.core.recordIosDeviceOutcome({
    id: approved.id,
    seen: { status: approved.status, approvedAtMs: approved.approved_at_ms },
    issuerId: apiKey.issuerId,
    outcome:
      result!.outcome === "refused"
        ? "refused"
        : result!.outcome === "disabled"
          ? "disabled"
          : "registered",
    ...(result!.outcome === "refused" ? { reason: result!.reason } : {}),
  });
  return result!;
};

/**
 * `native-build devices add`: registers iOS devices with the Apple account of
 * the scheme's App Store Connect API key, and records them in the device
 * registry as approved. Without `--udid`, a terminal picks from the devices
 * testers requested. Each new device uses one of the account's yearly slots.
 */
export const handleNativeBuildDevicesAdd = async (
  options: NativeBuildDevicesAddOptions,
) => {
  printBanner();
  try {
    const passed = parseDevices(options);
    if (passed.length === 0 && nonInteractiveReason() !== undefined) {
      throw new Error(
        "Pass --udid and --name, or run this at a terminal to pick from the requested devices.",
      );
    }
    const { outcomes, scheme } = await withDevices(
      options.scheme,
      async (context) => {
        const { server } = context;
        const picked: { row: IosDeviceRow; name: string }[] = [];
        if (passed.length > 0) {
          for (const { udid, name } of passed) {
            const { device } = await server.core.requestIosDevice({
              udid,
              name,
              requestedBy: null,
            });
            picked.push({ row: device, name });
          }
        } else {
          const waiting = [
            ...(await listRegistry(server, "pending")),
            ...(await listRegistry(server, "approved")),
          ];
          if (waiting.length === 0) {
            p.log.info(
              "No iOS devices are waiting. Testers register on the Console's iOS devices page.",
            );
            return { outcomes: [], scheme: context.scheme };
          }
          const chosen = await p.multiselect({
            message:
              "Register which devices with Apple now? Each new one uses one of the account's 100 a year.",
            options: waiting.map((row) => ({
              value: row.id,
              label: row.name,
              hint: [
                row.status === "pending" ? "requested" : "approved",
                row.requested_by,
                row.apple_error,
              ]
                .filter(Boolean)
                .join(" · "),
            })),
            required: true,
          });
          if (p.isCancel(chosen)) {
            p.log.info("Nothing was registered.");
            return { outcomes: [], scheme: context.scheme };
          }
          const ids = new Set(chosen);
          for (const row of waiting) {
            if (ids.has(row.id)) picked.push({ row, name: row.name });
          }
        }
        const outcomes: AscDeviceOutcome[] = [];
        for (const { row, name } of picked) {
          const result = await approveAndRegister(context, row, name);
          reportOutcome(name, result);
          outcomes.push(result);
        }
        return { outcomes, scheme: context.scheme };
      },
    );
    const rebuildable = outcomes.filter(
      ({ outcome }) =>
        outcome === "registered" || outcome === "already-registered",
    );
    if (rebuildable.length > 0) {
      p.log.info(
        ui.withCommand(
          "An existing .ipa never gains a device. Build again:",
          `npx hot-updater native-build ios --scheme ${scheme}`,
        ),
      );
    }
    if (rebuildable.length !== outcomes.length) process.exitCode = 1;
  } catch (error) {
    fail(error);
  }
};

const STATUS_LABELS: Record<IosDeviceRow["status"], string> = {
  pending: "Requested",
  approved: "Approved",
  registered: "Registered",
};

const appleLabel = (device: AscDevice | undefined) =>
  device === undefined
    ? "—"
    : device.status === "DISABLED"
      ? "Disabled"
      : "Enabled";

/**
 * `native-build devices list`: the device registry and the Apple account's
 * devices, side by side by UDID, read each time.
 */
export const handleNativeBuildDevicesList = async (
  options: NativeBuildDevicesOptions,
) => {
  printBanner();
  try {
    const { rows, devices } = await withDevices(
      options.scheme,
      async ({ apiKey, server }) => ({
        rows: await listRegistry(server),
        devices: await listAscDevices({ apiKey }),
      }),
    );
    const atApple = new Map(
      devices.map((device) => [
        normalizeIosUdid(device.udid) ?? device.udid.toLowerCase(),
        device,
      ]),
    );
    const listed = new Set<string>();
    const table = rows.map((row) => {
      listed.add(row.udid);
      return {
        name: row.name,
        udid: row.udid,
        requestedBy: row.requested_by ?? "—",
        status: STATUS_LABELS[row.status],
        apple: appleLabel(atApple.get(row.udid)),
      };
    });
    for (const [udid, device] of atApple) {
      if (listed.has(udid)) continue;
      table.push({
        name: device.name,
        udid: device.udid,
        requestedBy: "—",
        status: "—",
        apple: appleLabel(device),
      });
    }
    if (table.length === 0) {
      p.log.info(
        "No iOS devices yet. Testers register on the Console's iOS devices page.",
      );
      return;
    }
    p.log.message(
      ui.table(
        [
          { key: "name", label: "Name" },
          { key: "udid", label: "UDID" },
          { key: "requestedBy", label: "Requested by" },
          { key: "status", label: "Status" },
          { key: "apple", label: "Apple" },
        ],
        table,
      ),
    );
  } catch (error) {
    fail(error);
  }
};

/**
 * `native-build devices rename`: the name in the device registry and the one
 * App Store Connect shows, together.
 */
export const handleNativeBuildDevicesRename = async (
  options: NativeBuildDevicesRenameOptions,
) => {
  printBanner();
  try {
    const udid = udidOrThrow(options.udid);
    const name = options.name.trim();
    if (name.length === 0 || name.length > 100) {
      throw new Error("--name takes 1 to 100 characters.");
    }
    await withDevices(options.scheme, async ({ apiKey, server }) => {
      const row = await server.core.findIosDevice(udid);
      const device = await findAscDevice({ udid, apiKey });
      if (row === null && device === null) {
        throw new Error(
          `${options.udid} isn't in the registry or the Apple account.\nList them: npx hot-updater native-build devices list`,
        );
      }
      if (row !== null) await server.core.renameIosDevice(row.id, name);
      if (device !== null && device.name !== name) {
        await updateAscDevice({ device, change: { name }, apiKey });
      }
      p.log.success(
        `Renamed to ${name}${row !== null && device !== null ? " in the registry and at Apple" : row !== null ? " in the registry" : " at Apple"}.`,
      );
    });
  } catch (error) {
    fail(error);
  }
};

/**
 * `native-build devices remove`: deletes the device from the registry and,
 * once confirmed, disables it in the Apple account, which keeps it out of new
 * ad hoc builds. Apple never returns its slot before the membership year renews.
 */
export const handleNativeBuildDevicesRemove = async (
  options: NativeBuildDevicesRemoveOptions,
) => {
  printBanner();
  try {
    const udid = udidOrThrow(options.udid);
    await withDevices(options.scheme, async ({ apiKey, server }) => {
      const row = await server.core.findIosDevice(udid);
      const device = await findAscDevice({ udid, apiKey });
      if (row === null && device === null) {
        throw new Error(
          `${options.udid} isn't in the registry or the Apple account.\nList them: npx hot-updater native-build devices list`,
        );
      }
      const name = row?.name ?? device!.name;
      if (row !== null) {
        await server.core.deleteIosDevice(row.id);
        p.log.success(`Removed ${name} from the registry.`);
      }
      if (device === null || device.status === "DISABLED") {
        if (device !== null)
          p.log.step(`${name} is already disabled at Apple.`);
        return;
      }
      if (row?.apple_issuer_id && row.apple_issuer_id !== apiKey.issuerId) {
        p.log.warn(
          `${name} was registered by another Apple account than this scheme's, so it stays enabled there.`,
        );
        return;
      }
      const consequence =
        "Its slot isn't returned until the membership year renews, and it leaves new builds of every app on the team.";
      let disable = options.yes === true;
      if (!disable) {
        if (nonInteractiveReason() !== undefined) {
          p.log.info(
            ui.withCommand(
              `${name} is still enabled at Apple, so new ad hoc builds keep it. Disable it:`,
              `npx hot-updater native-build devices remove --udid ${options.udid} --yes`,
            ),
          );
          return;
        }
        const answer = await p.confirm({
          initialValue: false,
          message: `Disable ${name} at Apple too? ${consequence}`,
        });
        disable = !p.isCancel(answer) && answer;
      }
      if (!disable) {
        p.log.info(
          `${name} stays enabled at Apple, so new ad hoc builds keep it.`,
        );
        return;
      }
      await updateAscDevice({
        device,
        change: { status: "DISABLED" },
        apiKey,
      });
      p.log.success(`Disabled ${name} at Apple. ${consequence}`);
    });
  } catch (error) {
    fail(error);
  }
};

import fs from "node:fs/promises";

import {
  type AscDevice,
  addAscDevices,
  listAscDevices,
} from "@hot-updater/apple-helper";
import {
  type Credentials,
  p,
  parseSecretReference,
} from "@hot-updater/cli-tools";
import type {
  HotUpdaterCoreApi,
  IosDeviceOutcome,
  IosDeviceRow,
} from "@hot-updater/plugin-core";
import { normalizeIosUdid } from "@hot-updater/protocol/native-artifact";
import { execa } from "execa";
import plist from "plist";

/** One registry row a build expects its `.ipa` to list. */
export interface ExpectedIosDevice {
  readonly id: string;
  readonly udid: string;
  readonly name: string;
}

/** What the build did with the device registry, by name: `--json`'s `devices`. */
export interface IosDeviceRegistryReport {
  /** Devices this run registered with Apple, each using a slot. */
  readonly registered: readonly string[];
  /** Approved devices this build couldn't register: no key, manual signing, another account. */
  readonly waiting: number;
  /** Devices Apple refused or has disabled, with why. */
  readonly problems: readonly {
    readonly name: string;
    readonly reason: string;
  }[];
  /** Registered devices Apple no longer lists, back to pending. */
  readonly missing: readonly string[];
}

export interface IosDeviceRegistryStep {
  /** The devices the `.ipa` must list: enabled at Apple in this account. */
  readonly expected: readonly ExpectedIosDevice[];
  readonly report: IosDeviceRegistryReport;
}

type RegistryCore = Pick<
  HotUpdaterCoreApi,
  "listIosDevices" | "findIosDevice" | "recordIosDeviceOutcome"
>;

/** A registry page: past the account's yearly limit, so one page holds every row. */
const PAGE = 200;

const DEVICES_URL =
  "https://developer.apple.com/account/resources/devices/list";

const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

/** Every row in a status, a page at a time. */
const listAll = async (
  core: RegistryCore,
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
 * The account the registry belongs to: the issuer of its earliest registered
 * row, by when and then by ID, or null before the first registration.
 */
export const registryIssuer = (
  registered: readonly IosDeviceRow[],
): string | null =>
  registered
    .filter((row) => row.apple_issuer_id !== null)
    .sort(
      (a, b) =>
        (a.registered_at_ms ?? 0) - (b.registered_at_ms ?? 0) ||
        (a.id < b.id ? -1 : 1),
    )[0]?.apple_issuer_id ?? null;

/** The export options as a dictionary: XML read directly, binary through plutil. */
const readExportOptions = async (
  file: string,
): Promise<Record<string, unknown>> => {
  const parse = (text: string) => {
    const parsed = plist.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  };
  try {
    return parse(await fs.readFile(file, "utf8"));
  } catch {
    const { stdout } = await execa("plutil", [
      "-convert",
      "xml1",
      "-o",
      "-",
      file,
    ]);
    return parse(stdout);
  }
};

/**
 * Why Xcode's automatic ad hoc profile can't sign this scheme, which is what
 * picks up a newly registered device: manual signing, or a named profile.
 */
const manualSigning = async (exportOptionsPlist: string | undefined) => {
  if (exportOptionsPlist === undefined) return false;
  const options = await readExportOptions(exportOptionsPlist);
  const profiles = options["provisioningProfiles"];
  return (
    options["signingStyle"] === "manual" ||
    (typeof profiles === "object" &&
      profiles !== null &&
      Object.keys(profiles).length > 0)
  );
};

/** The scheme's own App Store Connect key, the one its export signs with. */
export const resolveSchemeAscApiKey = async (
  credentials: {
    resolve(request: {
      kind: "asc-api-key";
      name: string;
    }): Promise<Credentials["asc-api-key"]>;
  },
  ascApiKey: Parameters<typeof parseSecretReference>[0],
): Promise<Credentials["asc-api-key"]> =>
  credentials.resolve({
    kind: "asc-api-key",
    name: parseSecretReference(ascApiKey, "signing.ascApiKey"),
  });

/**
 * Before an ad hoc export: registers the approved devices of the registry
 * with the scheme's Apple account, one at a time, and says which devices the
 * `.ipa` must list. Each Apple answer is written before the next request, over
 * the row it was read as, so a removed row is never brought back and a
 * failure loses nothing Apple already took.
 *
 * Nothing reaches Apple, and nothing is expected, when the scheme can't put a
 * new device in its profile (no `signing.ascApiKey`, manual signing), when its
 * account isn't the registry's, or on a dry run. A device problem only warns;
 * the build goes on without it.
 */
export const registerApprovedDevices = async ({
  core,
  scheme,
  ascApiKey,
  exportOptionsPlist,
  resolveApiKey,
  dryRun,
}: {
  readonly core: RegistryCore;
  /** The `nativeBuild.ios` scheme's name, for what it prints. */
  readonly scheme: string;
  /** The scheme's `signing.ascApiKey`. */
  readonly ascApiKey: Parameters<typeof parseSecretReference>[0] | undefined;
  readonly exportOptionsPlist: string | undefined;
  readonly resolveApiKey: () => Promise<Credentials["asc-api-key"]>;
  readonly dryRun: boolean;
}): Promise<IosDeviceRegistryStep> => {
  const approved = await listAll(core, "approved");
  const registered = await listAll(core, "registered");
  const idle: IosDeviceRegistryStep = {
    expected: [],
    report: { registered: [], waiting: 0, problems: [], missing: [] },
  };
  if (approved.length === 0 && registered.length === 0) return idle;
  const waiting = (reason: string, fix: string): IosDeviceRegistryStep => {
    if (approved.length > 0) {
      p.log.warn(
        `${scheme} ${reason}, so ${plural(approved.length, "approved device waits", "approved devices wait")}.\n${fix}`,
      );
    }
    return { ...idle, report: { ...idle.report, waiting: approved.length } };
  };
  if (ascApiKey === undefined) {
    return waiting(
      "signs without signing.ascApiKey",
      "Set signing.ascApiKey on the scheme to register them.",
    );
  }
  if (await manualSigning(exportOptionsPlist)) {
    return waiting(
      "pins a provisioning profile",
      "Use automatic signing in its exportOptionsPlist to include them.",
    );
  }
  if (dryRun) {
    if (approved.length > 0) {
      p.log.info(
        `iOS devices · ${approved.length} approved; a real run registers those Apple lacks`,
      );
    }
    return { ...idle, report: { ...idle.report, waiting: approved.length } };
  }

  const apiKey = await resolveApiKey();
  const issuer = apiKey.issuerId;
  const pin = registryIssuer(registered);
  const ours = registered.filter((row) => row.apple_issuer_id === issuer);
  // Approved rows spend a slot only in the registry's own account.
  const toRegister = pin === null || pin === issuer ? approved : [];
  const otherAccount = () =>
    waiting(
      "signs with another Apple account than the registry's",
      "Build with a scheme whose signing.ascApiKey is in the registry's account.",
    );
  if (toRegister.length === 0 && ours.length === 0) return otherAccount();
  if (toRegister.length === 0) otherAccount();

  const atApple = new Map<string, AscDevice>(
    (await listAscDevices({ apiKey })).map((device) => [
      normalizeIosUdid(device.udid) ?? device.udid.toLowerCase(),
      device,
    ]),
  );
  const expected: ExpectedIosDevice[] = [];
  const report = {
    registered: [] as string[],
    waiting: approved.length - toRegister.length,
    problems: [] as { name: string; reason: string }[],
    missing: [] as string[],
  };
  const record = async (
    row: IosDeviceRow,
    outcome: IosDeviceOutcome,
    reason?: string,
  ) =>
    core.recordIosDeviceOutcome({
      id: row.id,
      seen: { status: row.status, approvedAtMs: row.approved_at_ms },
      issuerId: issuer,
      outcome,
      ...(reason === undefined ? {} : { reason }),
    });
  const disabled = async (row: IosDeviceRow) => {
    await record(row, "disabled");
    report.problems.push({ name: row.name, reason: "disabled" });
    p.log.warn(
      `${row.name} is disabled in the Apple account.\nEnable it: ${DEVICES_URL}`,
    );
  };
  const include = (row: IosDeviceRow) =>
    expected.push({ id: row.id, udid: row.udid, name: row.name });

  for (const row of ours) {
    const device = atApple.get(row.udid);
    if (device === undefined) {
      await record(row, "missing");
      report.missing.push(row.name);
      p.log.warn(
        `${row.name} is gone from the Apple account. Approve it again in the Console to register it.`,
      );
    } else if (device.status === "DISABLED") {
      if (row.apple_error === null) await disabled(row);
      else report.problems.push({ name: row.name, reason: "disabled" });
    } else {
      if (row.apple_error !== null) await record(row, "registered");
      include(row);
    }
  }

  for (const row of toRegister) {
    const device = atApple.get(row.udid);
    if (device?.status === "DISABLED") {
      await disabled(row);
      continue;
    }
    if (device !== undefined) {
      // Already in the account: no slot.
      if ((await record(row, "registered")) !== null) include(row);
      continue;
    }
    // Read again right before spending a slot: a row removed or changed
    // since the list isn't sent.
    const current = await core.findIosDevice(row.udid);
    if (
      current === null ||
      current.status !== "approved" ||
      current.approved_at_ms !== row.approved_at_ms
    ) {
      continue;
    }
    const [result] = await addAscDevices({
      devices: [{ udid: current.udid, name: current.name }],
      apiKey,
    });
    if (result === undefined) continue;
    if (result.outcome === "refused") {
      await record(current, "refused", result.reason);
      report.problems.push({ name: current.name, reason: result.reason });
      p.log.warn(
        result.limitReached
          ? `Apple refused ${current.name}: ${result.reason}\nTestFlight has no such limit: npx hot-updater testflight`
          : `Apple refused ${current.name}: ${result.reason}`,
      );
      continue;
    }
    if (result.outcome === "disabled") {
      await disabled(current);
      continue;
    }
    if ((await record(current, "registered")) === null) continue;
    if (result.outcome === "registered") report.registered.push(current.name);
    include(current);
  }

  if (report.registered.length > 0) {
    p.log.step(
      `iOS devices · registered ${report.registered.length} with Apple: ${report.registered.join(", ")}`,
    );
  }
  return { expected, report };
};

/**
 * The expected devices an exported `.ipa` doesn't list, read from the `.ipa`:
 * what fails the build before it is tracked.
 */
export const missingIpaDevices = (
  expected: readonly ExpectedIosDevice[],
  ipaDevices: readonly string[],
): ExpectedIosDevice[] =>
  expected.filter((device) => !ipaDevices.includes(device.udid));

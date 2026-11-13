import {
  createUUIDv7,
  DatabaseConstraintError,
  type HotUpdaterCoreApi,
  type IosDeviceOutcome,
  type IosDeviceRow,
  type IosDeviceStatus,
} from "@hot-updater/plugin-core";

import { after, type CoreDatabase } from "./reads";

/**
 * A device's UDID: 40 hex digits, or 8 and 16 joined by a hyphen. The same
 * rule as `normalizeIosUdid` of `@hot-updater/protocol/native-artifact`,
 * implemented here so the server's runtime never loads the artifact readers.
 */
const UDID = /^(?:[0-9a-f]{40}|[0-9a-f]{8}-[0-9a-f]{16})$/iu;

/** The form the registry stores and compares a UDID in, or null for text that isn't one. */
const normalizeIosUdid = (value: string): string | null => {
  const trimmed = value.trim();
  return UDID.test(trimmed) ? trimmed.toLowerCase() : null;
};

/** `ios_devices.name`'s bound in core's schema. */
const NAME_MAX_LENGTH = 100;

/** `ios_devices.requested_by` and `approved_by`'s bound: an email address. */
const EMAIL_MAX_LENGTH = 320;

/** `ios_devices.apple_issuer_id`'s bound. */
const ISSUER_MAX_LENGTH = 64;

/** How many registry rows one read takes while finding its account. */
const ACCOUNT_SCAN_PAGE = 200;

/** The one row of `ios_device_account`. */
const ACCOUNT_ROW = "registry";

/** `ios_devices.apple_error`'s bound. */
const ERROR_MAX_LENGTH = 512;

const STATUSES: readonly IosDeviceStatus[] = [
  "pending",
  "approved",
  "registered",
];

const OUTCOMES: readonly IosDeviceOutcome[] = [
  "registered",
  "refused",
  "disabled",
  "missing",
];

/** The `apple_error` of a device Apple has disabled. */
export const IOS_DEVICE_DISABLED_ERROR = "Disabled in the Apple account.";

/** The `apple_error` of a registered device Apple no longer lists. */
export const IOS_DEVICE_MISSING_ERROR =
  "Gone from the Apple account. Approve it again to register it.";

/** A device or registry request core cannot store: the caller's input. */
export class IosDeviceInputError extends TypeError {
  override readonly name = "IosDeviceInputError";
}

const pick = (row: Readonly<Record<string, unknown>>): IosDeviceRow => ({
  id: row.id as string,
  udid: row.udid as string,
  name: row.name as string,
  status: row.status as IosDeviceStatus,
  requested_by: (row.requested_by ?? null) as string | null,
  created_at_ms: row.created_at_ms as number,
  approved_by: (row.approved_by ?? null) as string | null,
  approved_at_ms: (row.approved_at_ms ?? null) as number | null,
  registered_at_ms: (row.registered_at_ms ?? null) as number | null,
  apple_issuer_id: (row.apple_issuer_id ?? null) as string | null,
  apple_error: (row.apple_error ?? null) as string | null,
  build_id: (row.build_id ?? null) as string | null,
});

const udidOf = (udid: unknown): string => {
  const key = typeof udid === "string" ? normalizeIosUdid(udid) : null;
  if (key === null) {
    throw new IosDeviceInputError(
      "Invalid iOS device: udid must be 40 hex digits, or 8 and 16 joined by a hyphen.",
    );
  }
  return key;
};

const nameOf = (name: unknown): string => {
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (trimmed.length === 0 || trimmed.length > NAME_MAX_LENGTH) {
    throw new IosDeviceInputError(
      `Invalid iOS device: name must be 1 to ${NAME_MAX_LENGTH} characters.`,
    );
  }
  return trimmed;
};

/** An email, lower-cased, or null for the CLI. */
const personOf = (value: unknown, field: string): string | null => {
  if (value === null) return null;
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (email.length === 0 || email.length > EMAIL_MAX_LENGTH) {
    throw new IosDeviceInputError(
      `Invalid iOS device: ${field} must be an email of at most ${EMAIL_MAX_LENGTH} characters, or null.`,
    );
  }
  return email;
};

/** Apple's words, on one line and within the column's bound. */
const errorText = (text: string): string => {
  const line = text.replace(/\s+/gu, " ").trim();
  return line.length > ERROR_MAX_LENGTH
    ? `${line.slice(0, ERROR_MAX_LENGTH - 1)}…`
    : line;
};

/**
 * The iOS device registry: the iPhones and iPads a team asked to install ad hoc
 * builds on. The Console writes requests and approvals, and the CLI what Apple
 * said, each over the row it read.
 */
export const createIosDeviceApi = (
  db: CoreDatabase,
  { now = Date.now }: { readonly now?: () => number } = {},
): Pick<
  HotUpdaterCoreApi,
  | "listIosDevices"
  | "findIosDevice"
  | "requestIosDevice"
  | "approveIosDevice"
  | "renameIosDevice"
  | "recordIosDeviceOutcome"
  | "markIosDevicesInBuild"
  | "deleteIosDevice"
  | "claimIosDeviceAccount"
  | "findIosDeviceAccount"
> => {
  const findIosDevice = async (udid: string) => {
    const key = normalizeIosUdid(udid);
    if (key === null) return null;
    const row = await db.findOne("ios_devices", { udid: key });
    return row === null ? null : pick(row);
  };

  /**
   * The issuer of the registry's earliest registration among its rows, by
   * when and then by ID, or null when no row names one: read only while the
   * registry has no account yet, a page at a time.
   */
  const accountOfRows = async (): Promise<string | null> => {
    let earliest: IosDeviceRow | null = null;
    for (let after: string | undefined; ; ) {
      const { rows } = await db.findMany("ios_devices", {
        index: "all",
        where: {},
        order: "asc",
        limit: ACCOUNT_SCAN_PAGE,
        ...(after === undefined ? {} : { range: { gt: after } }),
      });
      for (const row of rows.map(pick)) {
        if (row.apple_issuer_id === null) continue;
        if (
          earliest === null ||
          (row.registered_at_ms ?? 0) < (earliest.registered_at_ms ?? 0)
        ) {
          earliest = row;
        }
      }
      if (rows.length < ACCOUNT_SCAN_PAGE)
        return earliest?.apple_issuer_id ?? null;
      after = rows.at(-1)!.id as string;
    }
  };

  return {
    async listIosDevices(input) {
      if (input.status !== undefined && !STATUSES.includes(input.status)) {
        throw new IosDeviceInputError(
          `Invalid iOS device status: ${String(input.status)}. Expected ${STATUSES.join(", ")}.`,
        );
      }
      const page = {
        order: input.order ?? "asc",
        limit: input.limit,
        ...after(input),
      };
      const { rows } =
        input.status === undefined
          ? await db.findMany("ios_devices", {
              index: "all",
              where: {},
              ...page,
            })
          : await db.findMany("ios_devices", {
              index: "byStatus",
              where: { status: input.status },
              ...page,
            });
      return rows.map(pick);
    },

    findIosDevice,

    async requestIosDevice(input) {
      const udid = udidOf(input.udid);
      const name = nameOf(input.name);
      const requestedBy = personOf(input.requestedBy, "requestedBy");
      const existing = await db.findOne("ios_devices", { udid });
      if (existing !== null) return { device: pick(existing), created: false };
      const device: IosDeviceRow = {
        id: createUUIDv7(),
        udid,
        name,
        status: "pending",
        requested_by: requestedBy,
        created_at_ms: now(),
        approved_by: null,
        approved_at_ms: null,
        registered_at_ms: null,
        apple_issuer_id: null,
        apple_error: null,
        build_id: null,
      };
      try {
        await db.transaction(async (tx) => {
          tx.create("ios_devices", device);
        });
      } catch (error) {
        // Another request for the same UDID won the unique index: its row
        // stands, as one found above would.
        if (
          error instanceof DatabaseConstraintError &&
          error.reason === "unique"
        ) {
          const winner = await db.findOne("ios_devices", { udid });
          if (winner !== null) return { device: pick(winner), created: false };
        }
        throw error;
      }
      return { device, created: true };
    },

    async approveIosDevice(id, input) {
      const name = input.name === undefined ? undefined : nameOf(input.name);
      const approvedBy = personOf(input.approvedBy, "approvedBy");
      return db.transaction(async (tx) => {
        const row = await tx.findOne("ios_devices", { id });
        if (row === null) return null;
        const device = pick(row);
        const set = {
          ...(name === undefined || name === device.name ? {} : { name }),
          ...(device.status === "pending"
            ? {
                status: "approved" as const,
                approved_by: approvedBy,
                approved_at_ms: now(),
              }
            : {}),
        };
        if (Object.keys(set).length === 0) return device;
        tx.update("ios_devices", row, set);
        return { ...device, ...set };
      });
    },

    async renameIosDevice(id, input) {
      const name = nameOf(input);
      return db.transaction(async (tx) => {
        const row = await tx.findOne("ios_devices", { id });
        if (row === null) return null;
        const device = pick(row);
        if (device.name === name) return device;
        tx.update("ios_devices", row, { name });
        return { ...device, name };
      });
    },

    async recordIosDeviceOutcome({ id, seen, issuerId, outcome, reason }) {
      if (!OUTCOMES.includes(outcome)) {
        throw new IosDeviceInputError(
          `Invalid iOS device outcome: ${String(outcome)}. Expected ${OUTCOMES.join(", ")}.`,
        );
      }
      if (
        typeof issuerId !== "string" ||
        issuerId.trim().length === 0 ||
        issuerId.length > ISSUER_MAX_LENGTH
      ) {
        throw new IosDeviceInputError(
          `Invalid iOS device outcome: issuerId must be an App Store Connect issuer of at most ${ISSUER_MAX_LENGTH} characters.`,
        );
      }
      return db.transaction(async (tx) => {
        const row = await tx.findOne("ios_devices", { id });
        if (row === null) return null;
        const device = pick(row);
        // Only over the row the caller acted on, and only for the account
        // that registered it: a removed and re-requested row, or another
        // account's, is left alone.
        if (
          device.status !== seen.status ||
          device.approved_at_ms !== seen.approvedAtMs ||
          (device.apple_issuer_id !== null &&
            device.apple_issuer_id !== issuerId)
        ) {
          return null;
        }
        let set: Partial<IosDeviceRow>;
        switch (outcome) {
          case "registered":
            if (device.status === "pending") return null;
            set = {
              status: "registered",
              registered_at_ms: device.registered_at_ms ?? now(),
              apple_issuer_id: issuerId,
              apple_error: null,
            };
            break;
          case "refused":
            if (device.status !== "approved") return null;
            set = {
              apple_error: errorText(
                reason === undefined || reason.trim() === ""
                  ? "Apple refused it."
                  : reason,
              ),
            };
            break;
          case "disabled":
            if (device.status === "pending") return null;
            set = { apple_error: IOS_DEVICE_DISABLED_ERROR };
            break;
          case "missing":
            // Apple's yearly reset, or someone at Apple, removed it: spending
            // a slot on it again takes a new approval.
            if (device.status !== "registered") return null;
            set = {
              status: "pending",
              approved_by: null,
              approved_at_ms: null,
              apple_error: IOS_DEVICE_MISSING_ERROR,
            };
            break;
        }
        const changed = Object.entries(set).some(
          ([column, value]) =>
            device[column as keyof IosDeviceRow] !== (value ?? null),
        );
        if (changed) tx.update("ios_devices", row, set);
        return { ...device, ...set };
      });
    },

    async markIosDevicesInBuild({ buildId, ids }) {
      // One write per row: the rows are independent, and a store caps how many
      // one transaction may write.
      for (const id of new Set(ids)) {
        await db.transaction(async (tx) => {
          const row = await tx.findOne("ios_devices", { id });
          // A newer build already listed it: build IDs are UUIDv7s.
          if (
            row === null ||
            (typeof row.build_id === "string" && row.build_id >= buildId)
          ) {
            return;
          }
          tx.update("ios_devices", row, { build_id: buildId });
        });
      }
    },

    // What a claim would answer, with nothing written: the claim's row, or
    // the account the rows name.
    async findIosDeviceAccount() {
      const existing = await db.findOne("ios_device_account", {
        id: ACCOUNT_ROW,
      });
      const issuerId =
        existing === null
          ? await accountOfRows()
          : (existing.apple_issuer_id as string);
      return issuerId === null ? null : { issuerId };
    },

    async claimIosDeviceAccount(issuerId) {
      if (
        typeof issuerId !== "string" ||
        issuerId.trim().length === 0 ||
        issuerId.length > ISSUER_MAX_LENGTH
      ) {
        throw new IosDeviceInputError(
          `Invalid iOS device account: issuerId must be an App Store Connect issuer of at most ${ISSUER_MAX_LENGTH} characters.`,
        );
      }
      const answer = (held: string) => ({
        issuerId: held,
        claimed: held === issuerId,
      });
      const existing = await db.findOne("ios_device_account", {
        id: ACCOUNT_ROW,
      });
      if (existing !== null) return answer(existing.apple_issuer_id as string);
      // A registry whose rows already name an account, whatever their status
      // now (a device Apple dropped goes back to pending with its issuer),
      // belongs to the one that registered first, not to the caller.
      const holder = (await accountOfRows()) ?? issuerId;
      try {
        await db.transaction(async (tx) => {
          tx.create("ios_device_account", {
            id: ACCOUNT_ROW,
            apple_issuer_id: holder,
            claimed_at_ms: now(),
          });
        });
        return answer(holder);
      } catch (error) {
        // Another build claimed it first: the key admits one row.
        if (
          error instanceof DatabaseConstraintError &&
          (error.reason === "exists" || error.reason === "unique")
        ) {
          const winner = await db.findOne("ios_device_account", {
            id: ACCOUNT_ROW,
          });
          if (winner !== null) {
            return answer(winner.apple_issuer_id as string);
          }
        }
        throw error;
      }
    },

    async deleteIosDevice(id, only) {
      const requestedBy =
        only?.requestedBy === undefined
          ? undefined
          : personOf(only.requestedBy, "requestedBy");
      return db.transaction(async (tx) => {
        const row = await tx.findOne("ios_devices", { id });
        if (row === null) return null;
        const device = pick(row);
        // Checked over the row this transaction deletes, so a request
        // approved meanwhile is no longer its requester's to withdraw.
        if (
          (only?.status !== undefined && device.status !== only.status) ||
          (requestedBy !== undefined && device.requested_by !== requestedBy)
        ) {
          return null;
        }
        await tx.delete("ios_devices", row);
        return device;
      });
    },
  };
};

const LYNX_E2E_APP_ID = "com.hotupdater.lynxexample";

export function isLynxE2eAppId(appId: string): boolean {
  return appId === LYNX_E2E_APP_ID;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function decodeLynxIosStoredSelection(
  value: unknown,
): Record<string, unknown> | null {
  const stored = asRecord(value);
  if (!stored) {
    return null;
  }
  if (typeof stored.receipt !== "string") {
    return asRecord(stored.receipt) ?? asRecord(stored);
  }
  try {
    return asRecord(
      JSON.parse(Buffer.from(stored.receipt, "base64").toString("utf8")),
    );
  } catch {
    return null;
  }
}

export function lynxReceipt(
  journal: Record<string, unknown>,
  platform: "ios" | "android",
  key: "confirmed" | "next",
): Record<string, unknown> | null {
  const stored = journal[key];
  return platform === "ios"
    ? decodeLynxIosStoredSelection(stored)
    : asRecord(stored);
}

export function lynxCrashedBundleIds(
  journal: Record<string, unknown>,
  platform: "ios" | "android",
): string[] {
  const raw = platform === "ios" ? journal.crashedBundleIds : journal.crashed;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((id): id is string => typeof id === "string");
}

function selectionFromReceipt(receipt: Record<string, unknown> | null) {
  if (!receipt) {
    return null;
  }
  return {
    kind: asString(receipt.kind),
    bundleId: asString(receipt.bundleId),
    releaseId: asString(receipt.releaseId),
    catalogId: asString(receipt.catalogId),
    scopeKey: asString(receipt.scopeKey),
    generation: asNumber(receipt.generation),
    catalogHash: asString(receipt.catalogHash),
    channel: asString(receipt.channel),
    selectionContextHash: asString(receipt.selectionContextHash),
  };
}

function highWaterFromReceipt(
  receipt: Record<string, unknown> | null,
  androidHighWater: Record<string, unknown> | null,
) {
  const catalogId =
    asString(androidHighWater?.catalogId) ?? asString(receipt?.catalogId);
  const scopeKey =
    asString(androidHighWater?.scopeKey) ?? asString(receipt?.scopeKey);
  const generation =
    asNumber(androidHighWater?.generation) ?? asNumber(receipt?.generation);
  const catalogHash =
    asString(androidHighWater?.catalogHash) ?? asString(receipt?.catalogHash);
  if (!catalogId || !scopeKey || generation === null || !catalogHash) {
    return {};
  }
  return {
    [`${catalogId}|${scopeKey}`]: { catalogHash, generation },
  };
}

export function synthesizeLynxMetadata(
  journal: Record<string, unknown>,
  platform: "ios" | "android",
): Record<string, unknown> {
  const confirmed = lynxReceipt(journal, platform, "confirmed");
  const next = lynxReceipt(journal, platform, "next");
  const pending = asRecord(journal.pending);
  const crashed = lynxCrashedBundleIds(journal, platform);
  const nextBundleId = asString(next?.bundleId);
  const nextIsCrashed = nextBundleId !== null && crashed.includes(nextBundleId);
  const active = nextIsCrashed ? confirmed : (next ?? confirmed);
  const confirmedBundleId = asString(confirmed?.bundleId);
  const stagingBundleId = asString(active?.bundleId);
  const verificationPending =
    !nextIsCrashed &&
    (pending !== null ||
      (next !== null && asString(next.bundleId) !== confirmedBundleId));

  return {
    schema: "metadata-v2",
    stableBundleId: confirmedBundleId,
    stableSelection: selectionFromReceipt(confirmed),
    stagingBundleId,
    stagingSelection: selectionFromReceipt(active),
    verificationPending,
    highestSeenCatalogs: highWaterFromReceipt(
      active,
      asRecord(journal.highWater),
    ),
  };
}

export function synthesizeLynxCrashHistory(
  journal: Record<string, unknown>,
  platform: "ios" | "android",
): Record<string, unknown> {
  const bundleIds = lynxCrashedBundleIds(journal, platform);
  return {
    bundles: bundleIds.map((bundleId, index) => ({
      bundleId,
      crashCount: 1,
      crashedAt: index + 1,
    })),
    maxHistorySize: 10,
  };
}

export function synthesizeLynxLaunchReport(args: {
  readonly crashedBundleIds: readonly string[];
  readonly confirmedBundleId: string | null;
  readonly confirmedReleaseId: string | null;
  readonly fromReleaseId: string | null;
  readonly toReleaseId: string | null;
}): Record<string, unknown> | null {
  const crashedBundleId = args.crashedBundleIds.at(-1) ?? null;
  if (
    !crashedBundleId ||
    !args.confirmedBundleId ||
    crashedBundleId === args.confirmedBundleId
  ) {
    return null;
  }
  return {
    status: "RECOVERED",
    fromBundleId: crashedBundleId,
    toBundleId: args.confirmedBundleId,
    fromReleaseId: args.fromReleaseId,
    toReleaseId: args.toReleaseId ?? args.confirmedReleaseId,
  };
}

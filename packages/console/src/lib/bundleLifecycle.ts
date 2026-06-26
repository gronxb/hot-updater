import type { Bundle } from "@hot-updater/plugin-core";

export type ConsoleBundleLifecycle = {
  readonly active: number;
  readonly recovered: number;
  readonly lastSeenAt?: string | null;
};

export type BundleWithLifecycle = Bundle & {
  readonly lifecycle?: ConsoleBundleLifecycle;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

export function getBundleLifecycle(
  bundle: Bundle,
): ConsoleBundleLifecycle | undefined {
  const lifecycle = (bundle as { readonly lifecycle?: unknown }).lifecycle;

  if (
    !isRecord(lifecycle) ||
    !isNonNegativeInteger(lifecycle.active) ||
    !isNonNegativeInteger(lifecycle.recovered)
  ) {
    return undefined;
  }

  const lastSeenAt =
    typeof lifecycle.lastSeenAt === "string" || lifecycle.lastSeenAt === null
      ? lifecycle.lastSeenAt
      : undefined;

  return {
    active: lifecycle.active,
    recovered: lifecycle.recovered,
    ...(lastSeenAt === undefined ? {} : { lastSeenAt }),
  };
}

import { assertCanonicalChannelName } from "@hot-updater/protocol";

import type { NativeBuildDetailSearch } from "@/components/features/native-builds/NativeBuildDetailPage";
import type { NativeBuildPage } from "@/lib/api";

const text = (value: unknown) =>
  typeof value === "string" && value.length > 0 ? value : undefined;

/** A channel name a build can embed, or undefined. */
const channelName = (value: unknown) => {
  const channel = text(value);
  if (channel === undefined) return undefined;
  try {
    assertCanonicalChannelName(channel);
    return channel;
  } catch {
    return undefined;
  }
};

const defined = <T extends object>(values: T): T =>
  Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined),
  ) as T;

/**
 * The native build list's URL: a channel the builds embed, and one keyset
 * page. A page has one direction, so `before` wins over `after`.
 */
export const validateNativeBuildsSearch = (
  search: Record<string, unknown>,
): NativeBuildPage => {
  const before = text(search.before);
  return defined({
    channel: channelName(search.channel),
    before,
    after: before === undefined ? text(search.after) : undefined,
  });
};

/** A native build page's URL: one page of the patches from it. */
export const validateNativeBuildDetailSearch = (
  search: Record<string, unknown>,
): NativeBuildDetailSearch => {
  const patchesBefore = text(search.patchesBefore);
  return defined({
    patchesBefore,
    patchesAfter:
      patchesBefore === undefined ? text(search.patchesAfter) : undefined,
  });
};

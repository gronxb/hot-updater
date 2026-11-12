import type { IosDeviceStatus } from "@hot-updater/plugin-core";
import { assertCanonicalChannelName } from "@hot-updater/protocol";

import type { NativeBuildDetailSearch } from "@/components/features/native-builds/NativeBuildDetailPage";
import type { NativeBuildPage } from "@/lib/api";
import { ALL_CHANNELS, DEFAULT_CHANNEL } from "@/lib/constants";

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
 * The native build list's URL: a channel the builds embed, or every channel,
 * and one keyset page. A page has one direction, so `before` wins over
 * `after`.
 */
export type NativeBuildsSearch = NativeBuildPage & {
  /** Every channel, where the list would open on the default one. */
  readonly channels?: typeof ALL_CHANNELS;
};

export const validateNativeBuildsSearch = (
  search: Record<string, unknown>,
): NativeBuildsSearch => {
  const before = text(search.before);
  const channel = channelName(search.channel);
  return defined({
    channel,
    channels:
      channel === undefined && search.channels === ALL_CHANNELS
        ? ALL_CHANNELS
        : undefined,
    before,
    after: before === undefined ? text(search.after) : undefined,
  });
};

/**
 * The page the list reads. A URL that names no channel opens on the default
 * channel, or on every channel when the project has no such channel;
 * undefined until the channel names, which the page reads anyway, arrive.
 */
export const resolveNativeBuildsSearch = (
  { channels, ...page }: NativeBuildsSearch,
  channelNames: readonly string[] | undefined,
): NativeBuildPage | undefined => {
  if (page.channel !== undefined || channels === ALL_CHANNELS) return page;
  if (channelNames === undefined) return undefined;
  return channelNames.includes(DEFAULT_CHANNEL)
    ? { channel: DEFAULT_CHANNEL, ...page }
    : page;
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

const IOS_DEVICE_STATUSES: readonly IosDeviceStatus[] = [
  "pending",
  "approved",
  "registered",
];

/** The iOS devices page's URL: the status the list shows, all without one. */
export interface IosDevicesSearch {
  readonly status?: IosDeviceStatus;
}

export const validateIosDevicesSearch = (
  search: Record<string, unknown>,
): IosDevicesSearch =>
  typeof search.status === "string" &&
  IOS_DEVICE_STATUSES.includes(search.status as IosDeviceStatus)
    ? { status: search.status as IosDeviceStatus }
    : {};

import { assertCanonicalChannelName } from "./releaseCatalogScope";

/**
 * The path a channel link ends with, before its channel: a channel link is
 * `<prefix>hot-updater/channel/<channel>`. The prefix is the app's URL
 * scheme, such as `myapp://`, or a universal link's origin and path, such
 * as `https://example.com/`. The Console shows it as a QR code, and a
 * preview build opens it to switch to the channel.
 */
export const CHANNEL_LINK_PATH = "hot-updater/channel/";

/** The link a preview build opens to switch to `channel`. */
export const createChannelLink = (prefix: string, channel: string): string => {
  assertCanonicalChannelName(channel);
  const base = prefix.endsWith("/") ? prefix : `${prefix}/`;
  return `${base}${CHANNEL_LINK_PATH}${encodeURIComponent(channel)}`;
};

/**
 * The channel a channel link names, or null for any other URL. It reads the
 * URL as text, since React Native's `URL` implements little of the URL API.
 */
export const parseChannelLink = (url: string): string | null => {
  const match = /(?:^|\/)hot-updater\/channel\/([^/]+)\/?$/.exec(
    url.replace(/[?#][\s\S]*$/, ""),
  );
  if (match === null) return null;
  try {
    const channel = decodeURIComponent(match[1]!);
    assertCanonicalChannelName(channel);
    return channel;
  } catch {
    return null;
  }
};

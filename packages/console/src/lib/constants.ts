export const DEFAULT_PAGE_LIMIT = 20;

/**
 * The channel the SDK and the CLI use when none is chosen. Insights, Bundles,
 * and Native builds open on it when the URL names no channel.
 */
export const DEFAULT_CHANNEL = "production";

/**
 * The URL's `channels` value that lists every channel. It has a key of its
 * own because any name, `all` included, can be a channel's.
 */
export const ALL_CHANNELS = "all";

/** The channel filter's choice that lists every channel, on every page. */
export const ALL_CHANNELS_LABEL = "All channels";

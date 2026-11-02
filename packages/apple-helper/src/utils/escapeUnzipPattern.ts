/**
 * A zip entry name as `unzip` reads a literal member. It takes `*`, `?` and
 * `[...]` in a member name as wildcards, which a backslash escapes, so an
 * app named `My[Dev].app` would otherwise match nothing.
 */
export const escapeUnzipPattern = (name: string) =>
  name.replace(/[[\]*?\\]/gu, "\\$&");

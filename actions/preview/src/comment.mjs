// @ts-check

/**
 * The first line of the one comment the action keeps on a pull request,
 * which finds it again to edit it in place.
 */
export const COMMENT_MARKER = "<!-- hot-updater-preview -->";

const CREDIT = "Preview by [hot-updater](https://hot-updater.dev)";

/**
 * @typedef {"android" | "ios"} Platform
 * @typedef {"apk" | "aab" | "ipa" | "app"} ArtifactKind
 *
 * @typedef {object} PlatformPreview What one platform's run deployed.
 * @property {Platform} platform
 * @property {{ fingerprintHash: string | null, appVersion: string | null }} target
 *   What the native build was matched by.
 * @property {{ id: string, artifactKind: ArtifactKind }} nativeBuild
 * @property {boolean} built Whether this run built and registered the
 *   native build, rather than reusing a registered one.
 * @property {string} bundleId The bundle deployed to the pull request's channel.
 */

/**
 * `value` as one POSIX shell word: as it is when it holds only characters
 * no shell treats specially, else in single quotes. The Console's
 * `lib/shell.ts` quotes the commands it shows the same way.
 * @param {string} value
 */
export const shellQuote = (value) =>
  /^[\w@%+=:,./-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", `'\\''`)}'`;

/** @param {ArtifactKind} kind */
const platformLabel = (kind) =>
  ({
    apk: "Android",
    aab: "Android (AAB)",
    ipa: "iOS",
    app: "iOS Simulator",
  })[kind];

/**
 * A link under the Console, whose URL may have a path of its own.
 * @param {string} consoleUrl
 * @param {string} path
 * @param {Record<string, string>} query
 */
export const consoleLink = (consoleUrl, path, query) =>
  `${consoleUrl.replace(/\/+$/, "")}/${path}?${new URLSearchParams(query)}`;

/** @param {string} text */
const code = (text) => `\`${text}\``;

/** @param {string} text */
const escapeHtml = (text) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

/**
 * The last line: `notes`, then the credit unless it is off; none when both
 * are empty.
 * @param {string[]} notes
 * @param {boolean} credit
 */
const footer = (notes, credit) => {
  const parts = [...notes, ...(credit ? [CREDIT] : [])];
  return parts.length === 0 ? [] : [`<sub>${parts.join(" · ")}</sub>`];
};

/**
 * The comment of a pull request whose bundles were deployed: each
 * platform's native build, which the Console's Preview page installs, and
 * the QR code of the channel link that switches an installed preview build
 * to the pull request's channel.
 *
 * @param {object} input
 * @param {string} input.consoleUrl
 * @param {string} input.channel The pull request's channel.
 * @param {string} input.previewChannel The channel the native builds embed.
 * @param {PlatformPreview[]} input.previews
 * @param {{ link: string, qrCode: boolean } | null} input.channelLink The
 *   pull request's channel link, and whether the Console serves its QR code
 *   to the runner, or null when neither the Console nor the project's config
 *   sets `console.channelLinkPrefix`.
 * @param {string} input.headSha
 * @param {boolean} input.credit Whether to end with "Preview by hot-updater".
 */
export const renderPreviewComment = ({
  consoleUrl,
  channel,
  previewChannel,
  previews,
  channelLink,
  headSha,
  credit,
}) => {
  const strategies = new Set(
    previews.map(({ target }) =>
      target.fingerprintHash === null ? "App version" : "Fingerprint",
    ),
  );
  // A config can pick each platform's strategy.
  const targetHeading =
    strategies.size === 1 ? [...strategies][0] : "Fingerprint or app version";
  const rows = previews.map(({ target, nativeBuild, built, bundleId }) =>
    [
      platformLabel(nativeBuild.artifactKind),
      `[Install](${consoleLink(consoleUrl, "preview", { build: nativeBuild.id })}) · ${built ? "built for this commit" : "reused"}`,
      code(
        target.fingerprintHash === null
          ? String(target.appVersion)
          : target.fingerprintHash.slice(0, 12),
      ),
      code(bundleId),
    ].join(" | "),
  );
  const channelPage = consoleLink(consoleUrl, "preview", { channel });
  const open =
    channelLink === null
      ? [
          `Open this pull request's bundle in a preview build from the [Console](${channelPage}). Set ${code("console.channelLinkPrefix")} to show its channel link here.`,
        ]
      : [
          ...(channelLink.qrCode
            ? [
                `Scan the QR code with a device that has a preview build installed to open this pull request's bundle, or open the link:`,
                `<img src="${escapeHtml(consoleLink(consoleUrl, "_hot-updater/preview/channel-qr", { channel }))}" alt="${escapeHtml(`QR code of ${channelLink.link}`)}" width="180" height="180">`,
              ]
            : [
                `Open the link on a device that has a preview build installed to open this pull request's bundle, or scan its QR code in the Console:`,
              ]),
          `${code(channelLink.link)} · [Open in the Console](${channelPage})`,
          [
            "<details>",
            "<summary>Open it on an emulator or simulator</summary>",
            "",
            "```sh",
            `adb shell am start -a android.intent.action.VIEW -d ${shellQuote(shellQuote(channelLink.link))}`,
            `xcrun simctl openurl booted ${shellQuote(channelLink.link)}`,
            "```",
            "",
            "</details>",
          ].join("\n"),
        ];
  return [
    COMMENT_MARKER,
    `### Preview on ${code(channel)}`,
    [
      `| Platform | Native build | ${targetHeading} | Bundle |`,
      "| --- | --- | --- | --- |",
      ...rows.map((row) => `| ${row} |`),
    ].join("\n"),
    `Preview builds embed the ${code(previewChannel)} channel, and each pull request deploys to its own.`,
    ...open,
    ...footer([`Deployed ${code(headSha.slice(0, 7))}`], credit),
  ].join("\n\n");
};

/**
 * The comment of a closed pull request, once its channel is deleted: the
 * QR code and the bundles are gone.
 *
 * @param {object} input
 * @param {string} input.channel
 * @param {"deleted" | "kept" | "missing"} input.outcome `kept` when a native
 *   build embeds the channel, `missing` when it was already gone.
 * @param {number} input.deletedBundles
 * @param {boolean} input.credit
 */
export const renderClosedComment = ({
  channel,
  outcome,
  deletedBundles,
  credit,
}) => {
  const bundles = `${deletedBundles} bundle${deletedBundles === 1 ? "" : "s"}`;
  return [
    COMMENT_MARKER,
    `### Preview on ${code(channel)}`,
    {
      deleted: `This pull request is closed: its channel ${code(channel)} and its ${bundles} are deleted.`,
      kept: `This pull request is closed: its ${bundles} ${deletedBundles === 1 ? "is" : "are"} deleted, and its channel ${code(channel)} is kept, because a native build embeds it. Register preview builds on one shared channel, and deploy each pull request to its own.`,
      missing: `This pull request is closed, and its channel ${code(channel)} is already deleted.`,
    }[outcome],
    ...footer([], credit),
  ].join("\n\n");
};

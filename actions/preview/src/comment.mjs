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
 * @property {{ id: string, artifactKind: ArtifactKind, fileName: string }} nativeBuild
 *   The tracked build, and its artifact's file name.
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
  `${consolePath(consoleUrl, path)}?${new URLSearchParams(query)}`;

/**
 * A path under the Console, whose URL may have a path of its own.
 * @param {string} consoleUrl
 * @param {string} path
 */
export const consolePath = (consoleUrl, path) =>
  `${consoleUrl.replace(/\/+$/, "")}/${path}`;

/**
 * The Console's links of a native build: its download, which signs a phone
 * in and fetches a fresh storage URL each time, and its page.
 * @param {string} consoleUrl
 * @param {string} id
 */
const nativeBuildLinks = (consoleUrl, id) => {
  const encoded = encodeURIComponent(id);
  return `[Download](${consolePath(consoleUrl, `api/native-builds/${encoded}/download`)}) · [Details](${consolePath(consoleUrl, `native-builds/${encoded}`)})`;
};

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
 * How to install the downloaded artifacts on an emulator or simulator, or
 * none when no build installs that way.
 * @param {PlatformPreview[]} previews
 */
const installCommands = (previews) => {
  const lines = previews.flatMap(
    ({ nativeBuild: { artifactKind, fileName } }) =>
      artifactKind === "apk"
        ? [`adb install -r ${shellQuote(fileName)}`]
        : artifactKind === "app"
          ? [
              `unzip -o ${shellQuote(fileName)} && xcrun simctl install booted ${shellQuote(fileName.replace(/\.zip$/, ""))}`,
            ]
          : [],
  );
  return lines.length === 0
    ? []
    : [
        [
          "<details>",
          "<summary>Install on an emulator or simulator</summary>",
          "",
          "Download the build, then:",
          "",
          "```sh",
          ...lines,
          "```",
          "",
          "</details>",
        ].join("\n"),
      ];
};

/**
 * The comment of a pull request whose bundles were deployed: each
 * platform's native build, which embeds the pull request's channel, with
 * its Console download and page, and the QR code of an APK's download.
 *
 * @param {object} input
 * @param {string} input.consoleUrl
 * @param {string} input.channel The pull request's channel.
 * @param {PlatformPreview[]} input.previews
 * @param {string[]} input.qrCodes The APK builds whose download QR code the
 *   Console serves to the internet, which GitHub fetches a comment's images
 *   from.
 * @param {string} input.headSha
 * @param {boolean} input.credit Whether to end with "Preview by hot-updater".
 */
export const renderPreviewComment = ({
  consoleUrl,
  channel,
  previews,
  qrCodes,
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
      `${nativeBuildLinks(consoleUrl, nativeBuild.id)} · ${built ? "built for this commit" : "reused"}`,
      code(
        target.fingerprintHash === null
          ? String(target.appVersion)
          : target.fingerprintHash.slice(0, 12),
      ),
      code(bundleId),
    ].join(" | "),
  );
  const qr = previews.flatMap(({ nativeBuild }) =>
    qrCodes.includes(nativeBuild.id)
      ? [
          `<img src="${escapeHtml(consoleLink(consoleUrl, "_hot-updater/native-builds/qr", { build: nativeBuild.id }))}" alt="${escapeHtml(`QR code of the download of ${nativeBuild.fileName}`)}" width="180" height="180">`,
        ]
      : [],
  );
  const ipa = previews.some(
    ({ nativeBuild }) => nativeBuild.artifactKind === "ipa",
  );
  return [
    COMMENT_MARKER,
    `### Preview on ${code(channel)}`,
    [
      `| Platform | Native build | ${targetHeading} | Bundle |`,
      "| --- | --- | --- | --- |",
      ...rows.map((row) => `| ${row} |`),
    ].join("\n"),
    `This pull request's native builds embed the ${code(channel)} channel, so they open its bundle on their first launch.`,
    ...(qr.length === 0
      ? []
      : [
          "Scan with an Android phone to download the APK. The phone signs in to the Console first, and for a private Console it has to be on the Console's network.",
          qr.join(" "),
        ]),
    ...(ipa
      ? [
          `An IPA installs on registered devices; for testers, upload it to TestFlight with ${code("npx hot-updater testflight")}.`,
        ]
      : []),
    ...installCommands(previews),
    ...footer([`Deployed ${code(headSha.slice(0, 7))}`], credit),
  ].join("\n\n");
};

/**
 * The comment of a closed pull request, once its channel is deleted: its
 * bundles and native builds are gone.
 *
 * @param {object} input
 * @param {string} input.channel
 * @param {"deleted" | "kept" | "missing"} input.outcome `kept` when a bundle
 *   or a build was added to the channel during the cleanup, `missing` when
 *   it was already gone.
 * @param {number} input.deletedBundles
 * @param {number} input.deletedNativeBuilds
 * @param {boolean} input.credit
 */
export const renderClosedComment = ({
  channel,
  outcome,
  deletedBundles,
  deletedNativeBuilds,
  credit,
}) => {
  const bundles = `${deletedBundles} bundle${deletedBundles === 1 ? "" : "s"}`;
  const builds = `${deletedNativeBuilds} native build${deletedNativeBuilds === 1 ? "" : "s"}`;
  return [
    COMMENT_MARKER,
    `### Preview on ${code(channel)}`,
    {
      deleted: `This pull request is closed: its channel ${code(channel)}, its ${bundles}, and its ${builds} are deleted.`,
      kept: `This pull request is closed: its ${bundles} and its ${builds} are deleted, and its channel ${code(channel)} is kept, because a bundle or a build was added to it during the cleanup. Run the cleanup again.`,
      missing: `This pull request is closed, and its channel ${code(channel)} is already deleted.`,
    }[outcome],
    ...footer([], credit),
  ].join("\n\n");
};

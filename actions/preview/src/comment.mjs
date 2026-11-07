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
 * @property {import("../../shared/nativeBuild.mjs").StoreStatus | null} [store]
 *   The store a sandbox build went to, which installs it instead of a download.
 * @property {SandboxPreview} [sandbox] Present when a sandbox build runs the bundle.
 * @property {string} [fallbackScheme] The normal scheme this run used, because
 *   the pull request's native code differs from its sandbox builds'.
 *
 * @typedef {object} SandboxPreview
 * @property {string} appId The ID the link's URL scheme derives from.
 * @property {string | null} link The link a QR code holds; a build matched by
 *   app version has none, since a link names a fingerprint.
 * @property {string | null} minBundleId The oldest bundle ID the build runs.
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
 * A path under the Console, whose URL may have a path of its own.
 * @param {string} consoleUrl
 * @param {string} path
 */
export const consolePath = (consoleUrl, path) =>
  `${consoleUrl.replace(/\/+$/, "")}/${path}`;

/**
 * The Console's download of a native build, which signs a person in first
 * and fetches a fresh storage URL each time.
 * @param {string} consoleUrl
 * @param {string} id
 */
export const nativeBuildDownloadLink = (consoleUrl, id) =>
  consolePath(
    consoleUrl,
    `api/native-builds/${encodeURIComponent(id)}/download`,
  );

/**
 * A native build's Console page, where an iPhone checks and installs an IPA.
 * @param {string} consoleUrl
 * @param {string} id
 */
export const nativeBuildPageLink = (consoleUrl, id) =>
  consolePath(consoleUrl, `native-builds/${encodeURIComponent(id)}`);

/**
 * The command that downloads a simulator build, installs it on the booted
 * Simulator, and opens it, in the project with its `hot-updater.config.ts`.
 * The Console's `nativeBuildInstallCommand` shows the same one.
 * @param {string} id
 */
const nativeBuildInstallCommand = (id) =>
  `npx hot-updater native-build install ${shellQuote(id)}`;

/**
 * What a person opens to install a native build: the install command for a
 * simulator build, which no link installs, else the comment's Download link.
 * @param {string} consoleUrl
 * @param {{ id: string, artifactKind: ArtifactKind }} nativeBuild
 */
export const nativeBuildInstallUrl = (consoleUrl, { id, artifactKind }) =>
  artifactKind === "app"
    ? nativeBuildInstallCommand(id)
    : nativeBuildDownloadLink(consoleUrl, id);

/**
 * The link a sandbox build opens a channel from. `@hot-updater/protocol` has the
 * same `createPreviewLink`, which an action, with no dependencies, can't import;
 * the specs hold the two together.
 * @param {{ appId: string, channel: string, fingerprintHash: string }} link
 */
export const previewLink = ({ appId, channel, fingerprintHash }) =>
  `hu-sandbox-${appId.toLowerCase().replace(/[^a-z0-9]+/gu, "-")}://hot-updater/preview?channel=${encodeURIComponent(channel)}&fingerprint=${encodeURIComponent(fingerprintHash)}`;

/**
 * What each QR code of the comment holds: a sandbox build's link, which opens
 * the pull request's bundle in the sandbox app. Native builds get links, not
 * QR codes.
 *
 * @param {PlatformPreview[]} previews
 */
export const qrCodeValues = (previews) =>
  previews.flatMap(({ sandbox }) => (sandbox?.link ? [sandbox.link] : []));

/** Each store's name in the comment, and what its testers do. */
const STORE_NAMES = {
  testflight: "TestFlight",
  "play-internal": "Google Play internal testing",
};

/**
 * What a store's state means to a person reading the comment, or none for a
 * build whose store said nothing.
 * @type {Record<string, string>}
 */
const STORE_STATES = {
  ready: "ready to install",
  processing: "processing",
  "missing-compliance": "waiting on export compliance in App Store Connect",
  draft: "a draft: roll it out in Play Console",
};

/**
 * How a person installs a native build, as one line of links: its store, or
 * its Console download and page. A simulator build installs with the command
 * under the comment.
 *
 * @param {string} consoleUrl
 * @param {PlatformPreview} preview
 */
const installLinks = (
  consoleUrl,
  { nativeBuild: { id, artifactKind }, store },
) => {
  const download = nativeBuildDownloadLink(consoleUrl, id);
  const details = `[Details](${nativeBuildPageLink(consoleUrl, id)})`;
  if (store) {
    return [
      store.url
        ? `[${STORE_NAMES[store.destination]}](${store.url})`
        : STORE_NAMES[store.destination],
      ...(store.version ? [code(store.version)] : []),
      ...(store.state && STORE_STATES[store.state]
        ? [STORE_STATES[store.state]]
        : []),
      details,
    ].join(" · ");
  }
  return {
    apk: `[Download APK](${download}) · ${details} · allow "Install unknown apps" when Android asks`,
    aab: `[Download AAB](${download}) · ${details}`,
    ipa: `[Install on iPhone](${nativeBuildPageLink(consoleUrl, id)}) · [Download IPA](${download}) · registered devices only`,
    app: `${details} · install with the command below`,
  }[artifactKind];
};

/** @param {PlatformPreview} preview */
const installLabel = ({ platform, nativeBuild, store }) =>
  store
    ? platform === "ios"
      ? "iOS"
      : "Android"
    : platformLabel(nativeBuild.artifactKind);

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
 * How to install the builds on an emulator or simulator, or none when no
 * build installs that way: an APK once it is downloaded, and a simulator build
 * with the command that downloads it too.
 * @param {PlatformPreview[]} allPreviews
 */
const installCommands = (allPreviews) => {
  const previews = allPreviews.filter(({ store }) => !store);
  /**
   * @param {string} lead
   * @param {string[]} lines
   */
  const section = (lead, lines) =>
    lines.length === 0 ? [] : [lead, "", "```sh", ...lines, "```", ""];
  const sections = [
    ...section(
      "Download the build, then:",
      previews.flatMap(({ nativeBuild: { artifactKind, fileName } }) =>
        artifactKind === "apk"
          ? [`adb install -r ${shellQuote(fileName)}`]
          : [],
      ),
    ),
    ...section(
      "In your project, this downloads the build, installs it on the booted Simulator, and opens it:",
      previews.flatMap(({ nativeBuild: { artifactKind, id } }) =>
        artifactKind === "app" ? [nativeBuildInstallCommand(id)] : [],
      ),
    ),
  ];
  return sections.length === 0
    ? []
    : [
        [
          "<details>",
          "<summary>Install on an emulator or simulator</summary>",
          "",
          ...sections,
          "</details>",
        ].join("\n"),
      ];
};

/**
 * The rows of the collapsed Builds table: each platform's native build, the
 * fingerprint or app version it was matched by, and the deployed bundle.
 * @param {PlatformPreview[]} previews
 */
const buildsTable = (previews) => {
  const strategies = new Set(
    previews.map(({ target }) =>
      target.fingerprintHash === null ? "App version" : "Fingerprint",
    ),
  );
  // A config can pick each platform's strategy.
  const targetHeading =
    strategies.size === 1 ? [...strategies][0] : "Fingerprint or app version";
  return [
    "<details>",
    "<summary>Builds</summary>",
    "",
    `| Platform | Native build | ${targetHeading} | Bundle |`,
    "| --- | --- | --- | --- |",
    ...previews.map(
      (preview) =>
        `| ${installLabel(preview)} | ${code(preview.nativeBuild.id)} · ${preview.built ? "built for this commit" : "reused"} | ${code(
          preview.target.fingerprintHash === null
            ? String(preview.target.appVersion)
            : preview.target.fingerprintHash.slice(0, 12),
        )} | ${code(preview.bundleId)} |`,
    ),
    "",
    "</details>",
  ].join("\n");
};

/**
 * The comment of a pull request whose bundles were deployed, in the order a
 * tester works: install the app, then, on a sandbox build, scan the QR code
 * of the sandbox link, which opens this pull request's bundle. Native builds
 * get links only; the sandbox link is the only QR code.
 *
 * @param {object} input
 * @param {string} input.consoleUrl
 * @param {string} input.channel The pull request's channel.
 * @param {PlatformPreview[]} input.previews
 * @param {Record<string, string>} [input.qrImages] The image of each sandbox
 *   link's QR code that the action wrote, by the link; a link without one is
 *   shown as text only.
 * @param {string} input.headSha
 * @param {boolean} input.credit Whether to end with "Preview by hot-updater".
 */
export const renderPreviewComment = ({
  consoleUrl,
  channel,
  previews,
  qrImages = {},
  headSha,
  credit,
}) => {
  /** @param {PlatformPreview} preview */
  const line = (preview) =>
    `- **${installLabel(preview)}**: ${installLinks(consoleUrl, preview)}`;
  const sandboxes = previews.filter(({ sandbox }) => sandbox);
  const own = previews.filter(({ sandbox }) => !sandbox);
  const linked = sandboxes.filter(({ sandbox }) => sandbox?.link);
  const older = sandboxes.filter(
    ({ sandbox, bundleId }) =>
      sandbox?.minBundleId && bundleId < sandbox.minBundleId,
  );
  const scannable = linked.some(
    ({ sandbox }) => qrImages[/** @type {string} */ (sandbox?.link)],
  );
  return [
    COMMENT_MARKER,
    `### Preview on ${code(channel)}`,
    ...(sandboxes.length === 0
      ? []
      : [
          `**${linked.length === 0 ? "" : "1. "}Install the sandbox app** once. Pull requests with the same native code share it.`,
          sandboxes.map(line).join("\n"),
          ...(sandboxes.some(({ built }) => built)
            ? [
                "This run made a new sandbox build: push the other open pull requests again.",
              ]
            : []),
        ]),
    ...(linked.length === 0
      ? []
      : [
          scannable
            ? "**2. Scan to open this pull request** with the sandbox app."
            : "**2. Open this pull request**: open the link on the phone with the sandbox app.",
          ...linked.map(({ platform, sandbox }) => {
            const link = /** @type {string} */ (sandbox?.link);
            return [
              `**${platform === "ios" ? "iOS" : "Android"}**`,
              ...(qrImages[link]
                ? [
                    `<img src="${escapeHtml(qrImages[link])}" alt="${escapeHtml(`QR code of the sandbox link of ${channel}`)}" width="180" height="180">`,
                  ]
                : []),
              code(link),
            ].join("\n\n");
          }),
        ]),
    ...older.map(
      ({ bundleId }) =>
        `Bundle ${code(bundleId)} is older than the sandbox build accepts: push again.`,
    ),
    ...(own.length === 0
      ? []
      : [
          sandboxes.length === 0
            ? "**Install this pull request's build.** It opens this pull request on its first launch."
            : "**This pull request's own build** opens this pull request on its first launch.",
          own.map(line).join("\n"),
        ]),
    buildsTable(previews),
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

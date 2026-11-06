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
 * The Console's links of a native build: its download and its page.
 * @param {string} consoleUrl
 * @param {string} id
 */
const nativeBuildLinks = (consoleUrl, id) =>
  `[Download](${nativeBuildDownloadLink(consoleUrl, id)}) · [Details](${nativeBuildPageLink(consoleUrl, id)})`;

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
 * What each QR code of the comment holds, in the comment's order: a sandbox
 * build's link, an APK's download, and an IPA's page, where an iPhone checks
 * whether it can install it. A store build has none: its store installs it.
 *
 * @param {string} consoleUrl
 * @param {PlatformPreview[]} previews
 */
export const qrCodeValues = (consoleUrl, previews) => [
  ...previews.flatMap(({ sandbox }) => (sandbox?.link ? [sandbox.link] : [])),
  ...previews.flatMap(({ nativeBuild, sandbox, store }) =>
    sandbox || store
      ? []
      : nativeBuild.artifactKind === "apk"
        ? [nativeBuildDownloadLink(consoleUrl, nativeBuild.id)]
        : nativeBuild.artifactKind === "ipa"
          ? [nativeBuildPageLink(consoleUrl, nativeBuild.id)]
          : [],
  ),
];

/**
 * @param {string} src
 * @param {string} alt
 */
const qrImage = (src, alt) =>
  `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" width="180" height="180">`;

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
 * A store build's cell: its store's page, its version and state, and its page
 * in the Console.
 * @param {string} consoleUrl
 * @param {{ id: string }} nativeBuild
 * @param {import("../../shared/nativeBuild.mjs").StoreStatus} store
 */
const storeBuildLinks = (consoleUrl, { id }, store) =>
  [
    store.url
      ? `[${STORE_NAMES[store.destination]}](${store.url})`
      : STORE_NAMES[store.destination],
    ...(store.version ? [code(store.version)] : []),
    ...(store.state && STORE_STATES[store.state]
      ? [STORE_STATES[store.state]]
      : []),
    `[Details](${consolePath(consoleUrl, `native-builds/${encodeURIComponent(id)}`)})`,
  ].join(" · ");

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
 * What a preview on a sandbox build adds: each link and its QR code, whether
 * the bundle runs on the build, and what a new sandbox build asks of the others.
 *
 * @param {string} channel
 * @param {PlatformPreview[]} previews
 * @param {Record<string, string>} qrImages Each QR code's image, by what it holds.
 */
const sandboxSections = (channel, previews, qrImages) => {
  const sandboxes = previews.filter(({ sandbox }) => sandbox);
  if (sandboxes.length === 0) return [];
  const linked = sandboxes.filter(({ sandbox }) => sandbox?.link);
  const older = sandboxes.filter(
    ({ sandbox, bundleId }) =>
      sandbox?.minBundleId && bundleId < sandbox.minBundleId,
  );
  const scannable = linked.some(
    ({ sandbox }) => qrImages[/** @type {string} */ (sandbox?.link)],
  );
  return [
    ...(linked.length === 0
      ? []
      : [
          scannable
            ? "Scan with a phone that has the sandbox build to open this pull request. A sandbox build with other native code refuses the link."
            : "On a phone that has the sandbox build, open the link to open this pull request. A sandbox build with other native code refuses it.",
          ...linked.map(({ platform, sandbox }) => {
            const link = /** @type {string} */ (sandbox?.link);
            return [
              `**${platform === "ios" ? "iOS" : "Android"}**`,
              ...(qrImages[link]
                ? [
                    qrImage(
                      qrImages[link],
                      `QR code of the sandbox link of ${channel}`,
                    ),
                  ]
                : []),
              code(link),
            ].join("\n\n");
          }),
        ]),
    ...older.map(
      ({ bundleId, nativeBuild }) =>
        `Bundle ${code(bundleId)} is older than sandbox build ${code(nativeBuild.id)} accepts. Push again.`,
    ),
    ...(older.length === sandboxes.length
      ? []
      : [
          "This pull request's bundle runs on the sandbox build above. A newer sandbox build won't run it: push again.",
        ]),
    ...(sandboxes.some(({ built }) => built)
      ? [
          "This run made a new sandbox build, which other open pull requests' bundles may not run on. Push those pull requests again.",
        ]
      : []),
  ];
};

/**
 * The comment of a pull request whose bundles were deployed: each
 * platform's native build, which embeds the pull request's channel, with
 * its Console download and page, and the QR code of an APK's download or an
 * IPA's page.
 *
 * @param {object} input
 * @param {string} input.consoleUrl
 * @param {string} input.channel The pull request's channel.
 * @param {PlatformPreview[]} input.previews
 * @param {Record<string, string>} [input.qrImages] The image of each QR code
 *   the action wrote, by what it holds (see {@link qrCodeValues}); a QR code
 *   with none is left out.
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
  const strategies = new Set(
    previews.map(({ target }) =>
      target.fingerprintHash === null ? "App version" : "Fingerprint",
    ),
  );
  // A config can pick each platform's strategy.
  const targetHeading =
    strategies.size === 1 ? [...strategies][0] : "Fingerprint or app version";
  const rows = previews.map(({ target, nativeBuild, built, bundleId, store }) =>
    [
      store
        ? nativeBuild.artifactKind === "ipa"
          ? "iOS"
          : "Android"
        : platformLabel(nativeBuild.artifactKind),
      `${store ? storeBuildLinks(consoleUrl, nativeBuild, store) : nativeBuildLinks(consoleUrl, nativeBuild.id)} · ${built ? "built for this commit" : "reused"}`,
      code(
        target.fingerprintHash === null
          ? String(target.appVersion)
          : target.fingerprintHash.slice(0, 12),
      ),
      code(bundleId),
    ].join(" | "),
  );
  /** @param {"apk" | "ipa"} kind */
  const qrImagesOf = (kind) =>
    previews.flatMap(({ nativeBuild, sandbox, store }) => {
      if (sandbox || store || nativeBuild.artifactKind !== kind) return [];
      const src =
        qrImages[
          kind === "apk"
            ? nativeBuildDownloadLink(consoleUrl, nativeBuild.id)
            : nativeBuildPageLink(consoleUrl, nativeBuild.id)
        ];
      return src
        ? [
            qrImage(
              src,
              `QR code of the ${kind === "apk" ? "download" : "page"} of ${nativeBuild.fileName}`,
            ),
          ]
        : [];
    });
  const qr = qrImagesOf("apk");
  const iphoneQr = qrImagesOf("ipa");
  const ipa = previews.some(
    ({ nativeBuild, store }) => !store && nativeBuild.artifactKind === "ipa",
  );
  const stores = [
    ...new Set(previews.flatMap(({ store }) => store?.destination ?? [])),
  ];
  return [
    COMMENT_MARKER,
    `### Preview on ${code(channel)}`,
    [
      `| Platform | Native build | ${targetHeading} | Bundle |`,
      "| --- | --- | --- | --- |",
      ...rows.map((row) => `| ${row} |`),
    ].join("\n"),
    ...(previews.every(({ store, sandbox }) => store || sandbox)
      ? []
      : [
          `This pull request's native builds embed the ${code(channel)} channel, so they open its bundle on their first launch.`,
        ]),
    ...(stores.length === 0
      ? []
      : [
          `Testers install the sandbox build from ${stores.map((store) => STORE_NAMES[store]).join(" and ")}, which pull requests with the same native code share. This pull request's bundle is on ${code(channel)}.`,
        ]),
    ...previews.flatMap(({ platform, fallbackScheme }) =>
      fallbackScheme
        ? [
            `${platform === "ios" ? "iOS" : "Android"}: this pull request's native code differs from the sandbox builds', so it has its own native build and no sandbox QR code.`,
          ]
        : [],
    ),
    ...sandboxSections(channel, previews, qrImages),
    ...(qr.length === 0
      ? []
      : [
          "Scan with an Android phone to download the APK. The phone signs in to the Console first, and for a private Console it has to be on the Console's network.",
          qr.join(" "),
        ]),
    ...(iphoneQr.length === 0
      ? []
      : [
          "Scan with an iPhone to open the build's page, which checks whether the IPA includes it and installs it. The phone signs in to the Console first.",
          iphoneQr.join(" "),
        ]),
    ...(ipa
      ? [
          `An IPA installs on registered devices; for testers without one, upload it to TestFlight with ${code("npx hot-updater testflight")}.`,
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

/**
 * The app's hot-updater.config.ts for a deploy that signs with a foreign
 * key: its one `signing` object literal points at `privateKeyPath`, and no
 * Info.plist or AndroidManifest.xml is read, so the CLI's check that the
 * native public key matches the signer has no native key to compare. The app
 * already built still embeds the project's public key, which the deploy's
 * signature must not match.
 */
export function withForeignSigning(
  source: string,
  privateKeyPath: string,
): string {
  const pattern = /\bsigning\s*:\s*\{[^{}]*\}/g;
  const found = source.match(pattern)?.length ?? 0;
  if (found !== 1) {
    throw new Error(
      `hot-updater.config.ts sets signing as an object literal ${found} times; the foreign-key deploy replaces exactly one.`,
    );
  }
  return source.replace(
    pattern,
    [
      `signing: { enabled: true, privateKeyPath: ${JSON.stringify(privateKeyPath)} }`,
      "platform: { ios: { infoPlistPaths: [] }, android: { androidManifestPaths: [] } }",
    ].join(",\n  "),
  );
}

/**
 * The secret a deploy reads the project's key from: the config sets no
 * `secrets` adapter, so the CLI reads its variable, then this machine's key
 * store.
 */
export const PROJECT_SIGNING_KEY_SECRET = "bundle-signing-key";

/** The variable localSecrets() reads `PROJECT_SIGNING_KEY_SECRET` from. */
export const PROJECT_SIGNING_KEY_VARIABLE = "HOT_UPDATER_BUNDLE_SIGNING_KEY";

/**
 * The app's hot-updater.config.ts for a deploy that reads the project's key
 * through the config's `secrets` adapter: its one `signing` object literal
 * becomes the shorthand `secret("bundle-signing-key")`, with `secret` added
 * to its `hot-updater` import. The native files stay configured, so the CLI
 * still checks that the key it read matches the app's public key.
 */
export function withSecretSigning(source: string): string {
  const pattern = /\bsigning\s*:\s*\{[^{}]*\}/g;
  const found = source.match(pattern)?.length ?? 0;
  if (found !== 1) {
    throw new Error(
      `hot-updater.config.ts sets signing as an object literal ${found} times; the secret-key deploy replaces exactly one.`,
    );
  }
  const signed = source.replace(
    pattern,
    `signing: secret("${PROJECT_SIGNING_KEY_SECRET}")`,
  );
  const hotUpdaterImport = /import\s*\{([^}]*)\}\s*from\s*"hot-updater";/u;
  const named = signed.match(hotUpdaterImport)?.[1];
  if (named === undefined)
    return `import { secret } from "hot-updater";\n${signed}`;
  const names = named
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  return names.includes("secret")
    ? signed
    : signed.replace(
        hotUpdaterImport,
        `import { ${[...names, "secret"].join(", ")} } from "hot-updater";`,
      );
}

/**
 * The lines a deploy prints when `localSecrets()` has no
 * `PROJECT_SIGNING_KEY_SECRET`: what is missing, where else it may come
 * from, and the command that imports the key, on a line of its own.
 */
export const MISSING_SIGNING_SECRET_LINES = [
  `${PROJECT_SIGNING_KEY_SECRET} isn't on this machine.`,
  `Check the name, set ${PROJECT_SIGNING_KEY_VARIABLE}, or import your key:`,
  `npx hot-updater secrets put ${PROJECT_SIGNING_KEY_SECRET} <key.pem>`,
] as const;

/** The line a deploy that signing stops ends with. */
export const DEPLOYMENT_BLOCKED_LINE =
  "Deployment blocked. Fix the signing configuration and try again.";

/**
 * Whether a deploy without the key's secret was refused for it: the CLI
 * prints `MISSING_SIGNING_SECRET_LINES`, one after another, then blocks
 * the deploy, and records no release.
 */
export function refusedForMissingSigningSecret(output: string): boolean {
  // Each line without colors or the prompt library's frame.
  const lines = output
    // oxlint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;]*m/gu, "")
    .split("\n")
    .map((line) => line.replace(/^[\s│┌└◇◆■▲●○]+/u, "").trimEnd());
  const missing = lines.findIndex((_, index) =>
    MISSING_SIGNING_SECRET_LINES.every(
      (line, offset) => lines[index + offset] === line,
    ),
  );
  if (missing === -1) return false;
  const released = lines.some((line) =>
    /^ID\s+[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
      line,
    ),
  );
  return (
    !released &&
    lines
      .slice(missing + MISSING_SIGNING_SECRET_LINES.length)
      .includes(DEPLOYMENT_BLOCKED_LINE)
  );
}

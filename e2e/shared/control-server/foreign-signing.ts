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

/** The secret a deploy reads the project's key from, through `env()`. */
export const PROJECT_SIGNING_KEY_SECRET = "bundle-signing-key";

/** The variable `env()` reads `PROJECT_SIGNING_KEY_SECRET` from. */
export const PROJECT_SIGNING_KEY_VARIABLE = "HOT_UPDATER_BUNDLE_SIGNING_KEY";

/**
 * The app's hot-updater.config.ts for a deploy that reads the project's key
 * through the config's `secrets` adapter: its one `signing` object literal
 * names `secret:bundle-signing-key`. The native files stay configured, so the
 * CLI still checks that the key it read matches the app's public key.
 */
export function withSecretSigning(source: string): string {
  const pattern = /\bsigning\s*:\s*\{[^{}]*\}/g;
  const found = source.match(pattern)?.length ?? 0;
  if (found !== 1) {
    throw new Error(
      `hot-updater.config.ts sets signing as an object literal ${found} times; the secret-key deploy replaces exactly one.`,
    );
  }
  return source.replace(
    pattern,
    `signing: { enabled: true, privateKey: "secret:${PROJECT_SIGNING_KEY_SECRET}" }`,
  );
}

/**
 * Whether a deploy without the key's secret was refused for it: the CLI
 * names the variable `env()` read and blocks the deploy.
 */
export function refusedForMissingSigningSecret(output: string): boolean {
  return (
    output.includes(
      `which is not in the env secrets adapter (${PROJECT_SIGNING_KEY_VARIABLE} in the environment or .env.hotupdater)`,
    ) && output.includes("Deployment blocked.")
  );
}

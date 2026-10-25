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

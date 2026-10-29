import {
  addSigningSecretToConfig,
  BUNDLE_SIGNING_KEY_SECRET,
  describeStoredSecret,
  getCwd,
  keepsKeysOnThisMachine,
  loadConfig,
  nonInteractiveReason,
  p,
  readBundleSigningState,
  readLoadedHotUpdaterEnv,
  readSecretWithSource,
  registerCredentialValue,
} from "@hot-updater/cli-tools";

import { printBanner } from "@/utils/printBanner";

import { type MaybeRow, ui } from "../utils/cli-ui";
import { offerIssuedKeyToGitHub } from "../utils/native/issuedCredential";
import { storeCredential } from "../utils/native/storeCredential";
import {
  generateBundleSigningKey,
  readBundleSigningKey,
} from "../utils/signing/bundleSigningKey";
import {
  assertSecretName,
  environmentOverrides,
  listNames,
  reportFailure,
} from "./secrets";

const KIND = BUNDLE_SIGNING_KEY_SECRET;
const LABEL = "Bundle signing key";

/** What replacing a key costs, which is why a stored one is kept. */
const SHIPPED_APPS =
  "apps already shipped reject bundles signed with a new key.";

const issueCommand = (name: string) =>
  `npx hot-updater secrets issue ${KIND}${name === KIND ? "" : ` ${name}`}`;

/** The public key's fingerprint of a stored value, when it is a key. */
const fingerprintOf = (value: string, name: string): string | undefined => {
  try {
    return readBundleSigningKey(value, name).fingerprint;
  } catch {
    return undefined;
  }
};

/**
 * The row that says what `signing` reads once the key is stored: the
 * shorthand it added to hot-updater.config.ts, or, for a config that reads
 * another key, the line to set.
 */
const configRow = async (
  signing: unknown,
  name: string,
  cwd: string,
): Promise<MaybeRow> => {
  const shorthand = `signing: secret("${name}")`;
  const state = readBundleSigningState(signing);
  if (
    state.status === "on" &&
    "secret" in state.key &&
    state.key.secret === name
  ) {
    return undefined;
  }
  if (state.status === "unsigned") {
    const written = await addSigningSecretToConfig(cwd, name);
    if (written === "added") return ui.kv("Config", shorthand);
  }
  return ui.kv("Config", `set ${shorthand}`);
};

export interface SigningKeyIssueOptions {
  /** Create a new key even when one is stored, which it overwrites. */
  readonly replace?: boolean;
}

/**
 * `secrets issue bundle-signing-key`: creates an RSA key, as PKCS#8 PEM,
 * stores it as `name` through the config's `secrets` adapter, reads it
 * back, and names its public key's fingerprint, as `secrets put
 * bundle-signing-key` names a key you have. A config without `signing`
 * gets `signing: secret("<name>")`, also when the key is kept, such as one
 * `secrets put` stored; one that sets it is left as it is.
 *
 * - A key the environment sets is kept: `--replace` refuses until it is
 *   unset.
 * - A stored key is kept, unless `--replace`: apps already shipped verify
 *   bundles with its public key, and reject a new key's.
 * - With `localSecrets()`, it creates a key only at a terminal: a key
 *   created in CI, kept on the runner, would be lost with it. A team
 *   store keeps it, so CI may create one there.
 */
export const handleSigningKeyIssue = async (
  name: string = KIND,
  { replace = false }: SigningKeyIssueOptions = {},
): Promise<void> => {
  printBanner();
  await reportFailure(async () => {
    assertSecretName(name);
    // Registers the config's secrets adapter, which everything below uses.
    const { secrets, signing } = await loadConfig(null);
    const cwd = getCwd();
    const env = await readLoadedHotUpdaterEnv(cwd);

    const overrides = environmentOverrides(KIND, name, secrets, env);
    if (overrides.length > 0) {
      if (replace) {
        throw new Error(
          `The environment or .env.hotupdater overrides ${KIND}.\nUnset ${listNames(overrides)}.`,
        );
      }
      p.log.step(
        ui.block(`${LABEL} set by the environment`, [
          name !== KIND && ui.kv("Name", name),
          ui.kv("Source", listNames(overrides)),
          await configRow(signing, name, cwd),
        ]),
      );
      return;
    }

    const found = await readSecretWithSource(secrets, name, cwd);
    // Masked before anything can print it: only its fingerprint is named.
    if (found !== undefined) registerCredentialValue(found.value);
    const previous = found && fingerprintOf(found.value, name);
    if (found !== undefined && !replace) {
      p.log.step(
        ui.block(`${LABEL} already stored`, [
          name !== KIND && ui.kv("Name", name),
          previous && ui.kv("Public key", previous),
          ui.kv("Source", ui.fitPath(found.source)),
          // A key kept still signs: a config without signing gets it.
          await configRow(signing, name, cwd),
          `Kept: ${SHIPPED_APPS}`,
        ]),
      );
      return;
    }

    const reason = nonInteractiveReason();
    if (reason !== undefined && keepsKeysOnThisMachine(secrets)) {
      throw new Error(
        [
          `Can't create a ${LABEL.toLowerCase()} ${reason}.`,
          ui.withCommand(
            "Run in a terminal:",
            `${issueCommand(name)}${replace ? " --replace" : ""}`,
          ),
        ].join("\n"),
      );
    }

    const pem = await generateBundleSigningKey();
    // Masked before it is stored, so no failure can print it.
    registerCredentialValue(pem);
    await storeCredential(secrets, name, pem);
    const { fingerprint } = readBundleSigningKey(pem, name);
    p.log.success(
      ui.block(`${LABEL} created`, [
        name !== KIND && ui.kv("Name", name),
        ui.kv("Public key", fingerprint),
        ui.kv("Source", ui.fitPath(describeStoredSecret(secrets, name))),
        await configRow(signing, name, cwd),
      ]),
    );
    if (found !== undefined) {
      p.log.warn(
        ui.block(`The old ${LABEL.toLowerCase()} was replaced`, [
          previous && ui.kv("Public key", previous),
          "Apps that embed it reject bundles signed with the new key.",
        ]),
      );
    }
    p.log.info(
      ui.withCommand(
        "Embed its public key, then rebuild:",
        "npx hot-updater keys export-public",
      ),
    );
    await offerIssuedKeyToGitHub({ name, value: pem, secrets });
  });
};

import {
  describeSecret,
  describeStoredSecret,
  getConfiguredAdapter,
  getCwd,
  registerCredentialValue,
} from "@hot-updater/cli-tools";
import type { SecretsAdapter } from "@hot-updater/plugin-core";

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * Stores a credential's `value` as `name` through `secrets`, and reads it
 * back there: only an exact match counts as stored, so a store that loses
 * or never returns it fails here, not on a teammate's build. No copy is
 * kept on this machine.
 */
export const storeCredential = async (
  secrets: SecretsAdapter,
  name: string,
  value: string,
): Promise<void> => {
  // Masked before it is sent, so no failure can print it.
  registerCredentialValue(value);
  const cwd = getCwd();
  try {
    await secrets.set(name, value, { cwd });
  } catch (error) {
    throw new Error(
      `The ${secrets.name} secrets adapter didn't store ${name}.\n${errorText(error)}`,
      { cause: error },
    );
  }
  let held: string | undefined;
  let reason = "It reads back another value.";
  try {
    held = (await secrets.get([name], { cwd }))[name];
    if (held === undefined) reason = "It reads back nothing.";
  } catch (error) {
    reason = errorText(error);
  }
  if (held !== value) {
    throw new Error(
      [
        `${secrets.name} doesn't read ${name} back as stored.`,
        reason,
        getConfiguredAdapter(secrets)
          ? `Nothing is kept on this machine: check ${describeSecret(secrets, name)}.`
          : `Check ${describeStoredSecret(secrets, name)}.`,
      ].join("\n"),
    );
  }
};

import fs from "node:fs";
import path from "node:path";

import { getCwd, loadConfig, p } from "@hot-updater/cli-tools";

import { createAndInjectFingerprintFiles } from "@/utils/fingerprint";

/**
 * After a provider's init wrote hot-updater.config.ts: a fingerprint project
 * without fingerprint.json gets one, which native builds embed and deploy
 * targets. Without it, a build embeds no fingerprint and deploy refuses.
 * Returns the next steps init's closing prints: on a failure, the one
 * command that resolves it, and init still succeeds, since its cloud
 * resources exist by now.
 */
export const prepareInitFingerprint = async (): Promise<readonly string[]> => {
  let updateStrategy: string;
  try {
    ({ updateStrategy } = await loadConfig(null));
  } catch {
    return ["npx hot-updater doctor"];
  }
  if (updateStrategy !== "fingerprint") return [];
  if (fs.existsSync(path.join(getCwd(), "fingerprint.json"))) return [];

  const s = p.spinner();
  s.start("Creating fingerprint.json");
  try {
    await createAndInjectFingerprintFiles();
  } catch (error) {
    s.error(
      `Creating fingerprint.json failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return ["npx hot-updater fingerprint create"];
  }
  s.stop("Created fingerprint.json");
  p.log.info(
    "Commit fingerprint.json. Native builds embed its fingerprint, and deploy targets it.",
  );
  return [];
};

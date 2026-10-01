import * as awsInit from "@hot-updater/aws/init";
import type { InitProviderDefinition } from "@hot-updater/cli-tools";
import * as cloudflareInit from "@hot-updater/cloudflare/init";
import * as firebaseInit from "@hot-updater/firebase/init";
import * as supabaseInit from "@hot-updater/supabase/init";
import { describe, expect, it } from "vitest";

import { initHelp } from "./initHelp";

const providers: Readonly<Record<string, InitProviderDefinition>> = {
  cloudflare: cloudflareInit.initProvider,
  aws: awsInit.initProvider,
  supabase: supabaseInit.initProvider,
  firebase: firebaseInit.initProvider,
};

describe("init --help", () => {
  it("lists each provider's inputs as its package's init defines them, without the provider package installed", () => {
    const help = initHelp();

    for (const [name, provider] of Object.entries(providers)) {
      const inputs = Object.values(provider.inputs).map(
        ({ envKey, help, optional, requirementHint }) =>
          `  ${envKey}  ${help} (${
            optional ? "optional" : (requirementHint ?? "required")
          })`,
      );
      expect(help).toContain(
        [`${name} (${provider.label})`, ...inputs].join("\n"),
      );
    }
  });

  it("says which missing values --from-env-file reports before the install and which after", () => {
    expect(initHelp()).toContain(
      [
        "  --from-env-file disables init prompts. A missing build or provider is",
        "  reported before init installs packages, and every missing provider",
        "  input once the provider package is installed, before any resource",
        "  changes.",
      ].join("\n"),
    );
  });
});

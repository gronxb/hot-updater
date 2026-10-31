import {
  type CredentialResolver,
  createCredentialResolver,
  assertUnreservedEnv,
  p,
  parseSecretReference,
} from "@hot-updater/cli-tools";

import type { EnrichedNativeBuildAndroidScheme } from "./enrichNativeBuildAndroidScheme";

const isDebugVariant = (variant: string) => /debug$/i.test(variant);

/**
 * The environment that signs a release variant with the scheme's keystore,
 * through the properties Android Studio's signed builds inject. Gradle reads
 * `ORG_GRADLE_PROJECT_*` variables as project properties, so the passwords
 * never appear in the Gradle command line. The keystore is resolved only
 * here: a debug variant, or a scheme without `signing`, resolves nothing.
 * Without `credentials`, it resolves from the environment or the config's
 * `secrets` adapter, and the temporary files are deleted when the process
 * exits.
 */
export const resolveGradleSigningEnv = async ({
  schemeConfig,
  credentials,
}: {
  schemeConfig: EnrichedNativeBuildAndroidScheme;
  credentials?: Pick<CredentialResolver, "resolve">;
}): Promise<Record<string, string> | undefined> => {
  const reference = schemeConfig.signing?.keystore;
  if (!reference) {
    return undefined;
  }
  if (isDebugVariant(schemeConfig.variant)) {
    p.log.info(
      `${schemeConfig.variant} signs with the debug keystore; signing.keystore is unused.`,
    );
    return undefined;
  }

  const keystore = await (credentials ?? createCredentialResolver()).resolve({
    kind: "android-keystore",
    name: parseSecretReference(reference, "signing.keystore"),
  });
  return assertUnreservedEnv(
    {
      "ORG_GRADLE_PROJECT_android.injected.signing.store.file":
        keystore.storeFile,
      "ORG_GRADLE_PROJECT_android.injected.signing.store.password":
        keystore.storePassword,
      "ORG_GRADLE_PROJECT_android.injected.signing.key.alias":
        keystore.keyAlias,
      "ORG_GRADLE_PROJECT_android.injected.signing.key.password":
        keystore.keyPassword,
    },
    "The Gradle signing environment",
  );
};

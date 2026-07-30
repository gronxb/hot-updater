import { link, p } from "@hot-updater/cli-tools";

import { initProvider as FIREBASE_INIT_PROVIDER } from "./init/index";

export const inputFirebaseApplicationCredentials = async ({
  applicationCredentials,
  nonInteractive,
}: {
  readonly applicationCredentials?: string;
  readonly nonInteractive: boolean;
}): Promise<string | undefined> => {
  if (applicationCredentials || nonInteractive) {
    return applicationCredentials;
  }

  p.log.step(
    `Service account JSON: ${link(
      "https://console.firebase.google.com/project/_/settings/serviceaccounts/adminsdk",
    )}`,
  );
  p.log.step("Project settings > Service accounts > Generate new private key");

  const credentialsPath = await p.text({
    message:
      FIREBASE_INIT_PROVIDER.inputs.applicationCredentials.prompt.message,
    placeholder:
      FIREBASE_INIT_PROVIDER.inputs.applicationCredentials.prompt.placeholder,
  });
  if (p.isCancel(credentialsPath)) {
    process.exit(1);
  }
  return credentialsPath || undefined;
};

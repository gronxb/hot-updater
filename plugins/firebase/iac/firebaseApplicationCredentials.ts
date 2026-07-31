import {
  getInitProviderTextPromptValues,
  link,
  p,
} from "@hot-updater/cli-tools";

import { initProvider as FIREBASE_INIT_PROVIDER } from "./init/index";

export const inputFirebaseApplicationCredentials = async ({
  applicationCredentials,
  nonInteractive,
  projectId,
}: {
  readonly applicationCredentials?: string;
  readonly nonInteractive: boolean;
  readonly projectId: string;
}): Promise<string | undefined> => {
  if (nonInteractive) {
    return applicationCredentials;
  }

  const prompt = FIREBASE_INIT_PROVIDER.inputs.applicationCredentials.prompt;
  p.log.step(
    `Service account JSON: ${link(
      `https://console.firebase.google.com/project/${projectId}/settings/serviceaccounts/adminsdk`,
    )}`,
  );
  p.log.step("Project settings > Service accounts > Generate new private key");

  const credentialsPath = await p.text({
    ...getInitProviderTextPromptValues(prompt, applicationCredentials),
    message: prompt.message,
  });
  if (p.isCancel(credentialsPath)) {
    process.exit(1);
  }
  return credentialsPath || undefined;
};

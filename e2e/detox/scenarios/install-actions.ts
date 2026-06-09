import type { DetoxAppDriver } from "./types.ts";

export async function installCurrentChannelUpdate(
  app: DetoxAppDriver,
  stage: string,
): Promise<void> {
  await app.tap(stage, "action-install-current-channel-update");
  await app.assertText(
    `assert ${stage} started`,
    "update-action-start",
    "current-channel -> started",
  );
}

export async function installRuntimeChannelUpdate(
  app: DetoxAppDriver,
  stage: string,
): Promise<void> {
  await app.tap(stage, "action-install-runtime-channel-update");
  await app.assertText(
    `assert ${stage} started`,
    "update-action-start",
    "runtime-channel:beta -> started",
  );
}

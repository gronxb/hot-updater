import type { ScenarioAppDriver, ScenarioDefinition } from "./types.ts";

/** A QA-cohort value listed first, and a value every platform matches. */
const conditions = [
  { name: "QA cohort", rules: [{ type: "cohort", cohorts: ["qa"] }] },
  {
    name: "Every platform",
    rules: [{ type: "platform", platforms: ["ios", "android"] }],
  },
];

const message = {
  valueType: "STRING",
  defaultValue: { value: "server default" },
  conditionalValues: {
    "QA cohort": { value: "qa value" },
    "Every platform": { value: "platform value" },
  },
};

/** The first version: `e2e_flag` keeps the app's in-app default. */
const FIRST_TEMPLATE = {
  conditions,
  parameters: {
    e2e_message: message,
    e2e_limit: { valueType: "NUMBER", defaultValue: { value: "7" } },
    e2e_flag: { valueType: "BOOLEAN", defaultValue: { useInAppDefault: true } },
  },
};

const SECOND_TEMPLATE = {
  conditions,
  parameters: {
    e2e_message: message,
    e2e_limit: { valueType: "NUMBER", defaultValue: { value: "9" } },
    e2e_flag: { valueType: "BOOLEAN", defaultValue: { value: "false" } },
  },
};

const fetchAndActivate = async (app: ScenarioAppDriver, label: string) => {
  await app.tap(`fetch ${label}`, "action-fetch-remote-config");
  await app.assertText(
    `assert ${label} fetched`,
    "update-action-result",
    "remote-config fetch -> success",
    { exactText: true },
  );
  await app.tap(`activate ${label}`, "action-activate-remote-config");
  await app.assertText(
    `assert ${label} activated`,
    "update-action-result",
    "remote-config activate -> true",
    { exactText: true },
  );
};

const assertValues = (app: ScenarioAppDriver, stage: string, text: string) =>
  app.assertText(stage, "runtime-remote-config", text, { exactText: true });

export const remoteConfigFetchActivateScenario: ScenarioDefinition = {
  name: "remote-config-fetch-activate",
  run: async (app) => {
    // A Release no device receives, so the app stays on its built-in bundle.
    await app.control(
      "reset to a catalog without an update",
      "/e2e/jobs/deploy-bundle",
      {
        channel: "production",
        marker: "remote-config-fetch-activate-detox",
        mode: "reset",
        rollout: 0,
        safeBundleIds: [],
        targetAppVersion: "1.0.x",
      },
    );
    await app.control(
      "publish the first remote config",
      "/e2e/publish-remote-config",
      { template: FIRST_TEMPLATE, description: "E2E first version" },
      { saveResultFieldsAs: { remoteConfigVersion: "firstRemoteConfig" } },
    );
    await app.launch("launch the remote config app");
    await assertValues(
      app,
      "assert in-app defaults before a fetch",
      "message=in-app default(default) limit=1(default) flag=true(default)",
    );

    // A fetch keeps the values for activate; reads change only on activation.
    await app.tap("fetch the first version", "action-fetch-remote-config");
    await app.assertText(
      "assert the first version fetched",
      "update-action-result",
      "remote-config fetch -> success",
      { exactText: true },
    );
    await assertValues(
      app,
      "assert a fetch leaves the reads unchanged",
      "message=in-app default(default) limit=1(default) flag=true(default)",
    );
    await app.tap(
      "activate the first version",
      "action-activate-remote-config",
    );
    await app.assertText(
      "assert the first version activated",
      "update-action-result",
      "remote-config activate -> true",
      { exactText: true },
    );
    await assertValues(
      app,
      "assert the platform condition's value",
      "message=platform value(remote) limit=7(remote) flag=true(default)",
    );

    // The activated values load at setup, before any request.
    await app.reload("relaunch with the activated values");
    await assertValues(
      app,
      "assert the activated values after relaunch",
      "message=platform value(remote) limit=7(remote) flag=true(default)",
    );

    // The QA cohort is listed first, so it wins once the device is in it.
    await app.tap("join the qa cohort", "action-set-cohort-qa");
    await app.assertText(
      "assert the qa cohort applied",
      "cohort-action-result",
      "set -> qa",
    );
    await fetchAndActivate(app, "the qa cohort's values");
    await assertValues(
      app,
      "assert the qa cohort's value",
      "message=qa value(remote) limit=7(remote) flag=true(default)",
    );

    await app.control(
      "publish the second remote config",
      "/e2e/publish-remote-config",
      { template: SECOND_TEMPLATE, description: "E2E second version" },
    );
    await fetchAndActivate(app, "the second version");
    await assertValues(
      app,
      "assert the second version's values",
      "message=qa value(remote) limit=9(remote) flag=false(remote)",
    );

    // A rollback publishes the first version again: the flag is the app's
    // own default once more.
    await app.control(
      "roll back to the first remote config",
      "/e2e/rollback-remote-config",
      { version: "$firstRemoteConfig" },
    );
    await fetchAndActivate(app, "the rolled back version");
    await assertValues(
      app,
      "assert the rolled back values",
      "message=qa value(remote) limit=7(remote) flag=true(default)",
    );
  },
};

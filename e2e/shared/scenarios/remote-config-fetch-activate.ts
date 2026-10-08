import type { ScenarioAppDriver, ScenarioDefinition } from "./types.ts";

const ROLLOUT_SEED = "e2e-remote-config-rollout";

/**
 * A QA-cohort value listed first, a value for a share of installs, and a
 * value every platform matches.
 */
const conditionsFor = (rolloutPercent: number) => [
  { name: "QA cohort", rules: [{ type: "cohort", cohorts: ["qa"] }] },
  {
    name: "Rollout",
    rules: [
      { type: "percent", seed: ROLLOUT_SEED, from: 0, to: rolloutPercent },
    ],
  },
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
    Rollout: { value: "rollout value" },
    "Every platform": { value: "platform value" },
  },
};

const templateFor = ({
  rolloutPercent,
  limit,
  flag,
}: {
  readonly rolloutPercent: number;
  readonly limit: string;
  readonly flag: string | null;
}) => ({
  conditions: conditionsFor(rolloutPercent),
  parameters: {
    e2e_message: message,
    e2e_limit: { valueType: "NUMBER", defaultValue: { value: limit } },
    e2e_flag: {
      valueType: "BOOLEAN",
      defaultValue: flag === null ? { useInAppDefault: true } : { value: flag },
    },
  },
});

/** The first version: 10% of installs, and `e2e_flag` keeps the in-app default. */
const FIRST_TEMPLATE = templateFor({
  rolloutPercent: 10,
  limit: "7",
  flag: null,
});
/** The rollout widened to 25%: the first 10% stay in it. */
const WIDENED_TEMPLATE = templateFor({
  rolloutPercent: 25,
  limit: "7",
  flag: null,
});
const SECOND_TEMPLATE = templateFor({
  rolloutPercent: 25,
  limit: "9",
  flag: "false",
});

/** Fetches, then activates, as an app applies new values on load. */
const applyServerValues = async (app: ScenarioAppDriver, label: string) => {
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

/** Fetches and activates in one call, as an app that applies values on arrival. */
const fetchAndActivate = async (app: ScenarioAppDriver, label: string) => {
  await app.tap(
    `fetch and activate ${label}`,
    "action-fetch-and-activate-remote-config",
  );
  await app.assertText(
    `assert ${label} fetched and activated`,
    "update-action-result",
    "remote-config fetchAndActivate -> true",
    { exactText: true },
  );
};

const setCohort = async (
  app: ScenarioAppDriver,
  label: string,
  cohort: string,
) => {
  await app.typeText(`enter ${label}`, "cohort-input", cohort);
  await app.tap(`apply ${label}`, "action-apply-cohort-input");
  await app.assertText(
    `assert ${label} applied`,
    "cohort-action-result",
    `set -> ${cohort}`,
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
      "compute the rollout's cohorts",
      "/e2e/compute-remote-config-rollout-sample",
      { seed: ROLLOUT_SEED, percent: 10, widenedPercent: 25 },
      {
        saveResultFieldsAs: {
          excludedCohort: "excludedCohort",
          includedCohort: "includedCohort",
          widenedCohort: "widenedCohort",
        },
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
    await setCohort(app, "a cohort outside the rollout", "$excludedCohort");

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

    // A cohort the seed's shuffle puts in the first 10% gets the rollout's
    // value; one it puts between 10% and 25% gets it once the rollout widens.
    await setCohort(app, "a cohort in the rollout", "$includedCohort");
    await applyServerValues(app, "the rollout's values");
    await assertValues(
      app,
      "assert the rollout's value",
      "message=rollout value(remote) limit=7(remote) flag=true(default)",
    );
    await setCohort(app, "a cohort past the rollout", "$widenedCohort");
    await applyServerValues(app, "the values past the rollout");
    await assertValues(
      app,
      "assert the value past the rollout",
      "message=platform value(remote) limit=7(remote) flag=true(default)",
    );
    await app.control(
      "widen the rollout to 25%",
      "/e2e/publish-remote-config",
      { template: WIDENED_TEMPLATE, description: "E2E widened rollout" },
    );
    await applyServerValues(app, "the widened rollout's values");
    await assertValues(
      app,
      "assert the widened rollout's value",
      "message=rollout value(remote) limit=7(remote) flag=true(default)",
    );

    // The QA cohort is listed first, so it wins once the device is in it.
    await app.tap("join the qa cohort", "action-set-cohort-qa");
    await app.assertText(
      "assert the qa cohort applied",
      "cohort-action-result",
      "set -> qa",
    );
    await applyServerValues(app, "the qa cohort's values");
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

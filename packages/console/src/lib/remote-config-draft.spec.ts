// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  conditionNameError,
  createRule,
  describeRule,
  isSameTemplate,
  moveCondition,
  parameterKeyError,
  parametersUsing,
  removeCondition,
  removeParameter,
  type RemoteConfigTemplate,
  ruleError,
  splitList,
  summarizeChanges,
  upsertCondition,
  upsertParameter,
  valueTextError,
} from "./remote-config-draft";

const template: RemoteConfigTemplate = {
  conditions: [
    { name: "iOS", rules: [{ type: "platform", platforms: ["ios"] }] },
    { name: "Beta", rules: [{ type: "channel", channels: ["beta"] }] },
  ],
  parameters: {
    welcome: {
      valueType: "STRING",
      defaultValue: { value: "Hi" },
      conditionalValues: { iOS: { value: "Hi iOS" }, Beta: { value: "Hi β" } },
    },
    limit: { valueType: "NUMBER", defaultValue: { value: "5" } },
  },
};

describe("draft edits", () => {
  it("adds a parameter last and edits one in place, even under a new key", () => {
    const added = upsertParameter(template, null, "theme", {
      valueType: "STRING",
      defaultValue: { useInAppDefault: true },
    });
    expect(Object.keys(added.parameters)).toEqual([
      "welcome",
      "limit",
      "theme",
    ]);

    const renamed = upsertParameter(added, "welcome", "greeting", {
      valueType: "STRING",
      defaultValue: { value: "Hello" },
    });
    expect(Object.keys(renamed.parameters)).toEqual([
      "greeting",
      "limit",
      "theme",
    ]);
    expect(removeParameter(renamed, "limit").parameters).not.toHaveProperty(
      "limit",
    );
  });

  it("carries a renamed condition's values, and drops a removed one's", () => {
    const renamed = upsertCondition(template, "Beta", {
      name: "Testers",
      rules: [{ type: "channel", channels: ["beta", "qa"] }],
    });
    expect(renamed.conditions.map(({ name }) => name)).toEqual([
      "iOS",
      "Testers",
    ]);
    expect(renamed.parameters.welcome!.conditionalValues).toEqual({
      iOS: { value: "Hi iOS" },
      Testers: { value: "Hi β" },
    });

    const removed = removeCondition(renamed, "iOS");
    expect(removed.conditions.map(({ name }) => name)).toEqual(["Testers"]);
    expect(removed.parameters.welcome!.conditionalValues).toEqual({
      Testers: { value: "Hi β" },
    });
    // A parameter left without conditional values has no empty object.
    expect(removeCondition(removed, "Testers").parameters.welcome).toEqual({
      valueType: "STRING",
      defaultValue: { value: "Hi" },
    });
  });

  it("moves conditions within the list only", () => {
    expect(
      moveCondition(template, 1, -1).conditions.map(({ name }) => name),
    ).toEqual(["Beta", "iOS"]);
    expect(moveCondition(template, 0, -1)).toBe(template);
    expect(moveCondition(template, 1, 1)).toBe(template);
  });

  it("lists the parameters a condition sets", () => {
    expect(parametersUsing(template, "iOS")).toEqual(["welcome"]);
    expect(parametersUsing(template, "Nobody")).toEqual([]);
  });

  it("summarizes what a publish changes", () => {
    const draft = moveCondition(
      upsertParameter(
        removeParameter(template, "limit"),
        "welcome",
        "welcome",
        {
          valueType: "STRING",
          defaultValue: { value: "Hey" },
        },
      ),
      0,
      1,
    );
    expect(
      summarizeChanges(
        template,
        upsertCondition(draft, null, { name: "New", rules: [] }),
      ),
    ).toEqual({
      parameters: { added: [], changed: ["welcome"], removed: ["limit"] },
      conditions: { added: ["New"], changed: [], removed: [] },
      reordered: true,
    });
    expect(isSameTemplate(template, { ...template })).toBe(true);
    expect(isSameTemplate(template, draft)).toBe(false);
  });
});

describe("rule text", () => {
  it("describes each rule in a few words", () => {
    expect(
      [
        { type: "platform", platforms: ["ios", "android"] },
        { type: "channel", channels: ["a", "b", "c", "d"] },
        { type: "appVersion", range: ">=1.2.0" },
        { type: "cohort", cohorts: ["7"] },
        { type: "percent", seed: "s", from: 0, to: 12.5 },
        { type: "percent", seed: "s", from: 10, to: 20 },
        { type: "fingerprint", hashes: ["abcdef0123456789"] },
      ].map((rule) => describeRule(rule as never)),
    ).toEqual([
      "Platform is iOS, Android",
      "Channel is a, b, c +1",
      "App version >=1.2.0",
      "Cohort is 7",
      "12.5% of installs",
      "10–20% of installs",
      "Fingerprint is abcdef01",
    ]);
  });
});

describe("inline checks", () => {
  it("checks keys, names, and values as the server does", () => {
    expect(parameterKeyError("", [])).toBe("Enter a key.");
    expect(parameterKeyError("1st", [])).toContain("Start with a letter");
    expect(parameterKeyError("welcome", ["welcome"])).toContain("Another");
    expect(parameterKeyError("_ok_1", [])).toBeNull();

    expect(conditionNameError("  ", [])).toBe("Enter a name.");
    expect(conditionNameError(" iOS ", ["iOS"])).toContain("Another");

    expect(valueTextError("NUMBER", "1e3")).toBeNull();
    expect(valueTextError("NUMBER", "ten")).toBe("Enter a number.");
    expect(valueTextError("JSON", '{"a":1}')).toBeNull();
    expect(valueTextError("JSON", "{")).toBe("Enter valid JSON.");
    expect(valueTextError("BOOLEAN", "yes")).toBe("Choose true or false.");
    expect(valueTextError("STRING", "")).toBeNull();
  });

  it("starts each rule type with values to fill in, and checks them", () => {
    expect(ruleError(createRule("platform"))).toBeNull();
    expect(ruleError(createRule("channel"))).toBe("Enter a channel.");
    expect(ruleError(createRule("appVersion"))).toContain("version range");
    const percent = createRule("percent");
    expect(percent).toMatchObject({ from: 0, to: 10 });
    expect(ruleError(percent)).toBeNull();
    expect(ruleError({ ...percent, from: 20, to: 10 } as never)).toContain(
      "0 to 100",
    );
    expect(ruleError({ ...percent, to: 10.05 } as never)).toContain("0.1");
  });

  it("splits lists on commas and lines", () => {
    expect(splitList(" beta, qa\nbeta,, ")).toEqual(["beta", "qa"]);
  });
});

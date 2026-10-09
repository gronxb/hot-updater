// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  conditionalValueFor,
  conditionNameError,
  createDateTimeText,
  endPresets,
  startPresets,
  suggestConditionName,
  fromLocalDateTimeInput,
  toLocalDateTimeInput,
  createRule,
  describeConditionChange,
  describeParameterChange,
  describeRule,
  isSameTemplate,
  moveCondition,
  parameterKeyError,
  parametersUsing,
  readStoredDraft,
  type RemoteConfigCondition,
  removeCondition,
  removeParameter,
  type RemoteConfigTemplate,
  ruleError,
  splitList,
  storeDraft,
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

  it("treats names Object.prototype also has as the template's own", () => {
    const named = upsertCondition(template, null, {
      name: "constructor",
      rules: [{ type: "platform", platforms: ["android"] }],
    });
    expect(parametersUsing(named, "constructor")).toEqual([]);
    expect(
      conditionalValueFor(
        template.parameters.welcome!.conditionalValues,
        "toString",
      ),
    ).toBeUndefined();

    const draft = upsertParameter(
      removeParameter(named, "limit"),
      null,
      "toString",
      { valueType: "STRING", defaultValue: { value: "" } },
    );
    expect(summarizeChanges(named, draft).parameters).toEqual({
      added: ["toString"],
      changed: [],
      removed: ["limit"],
    });
    expect(
      summarizeChanges(draft, removeParameter(draft, "toString")).parameters,
    ).toEqual({ added: [], changed: [], removed: ["toString"] });
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
    // In UTC by default, as the server renders; a viewer's zone on request.
    const from = "2026-10-08T10:00:00.000Z";
    const to = "2026-10-09T10:00:00.000Z";
    expect(
      [
        { type: "dateTime", from, to },
        { type: "dateTime", from },
        { type: "dateTime", to },
      ].map((rule) => describeRule(rule as never)),
    ).toEqual([
      "From Oct 8, 2026, 10:00 UTC until Oct 9, 2026, 10:00 UTC",
      "From Oct 8, 2026, 10:00 UTC",
      "Until Oct 9, 2026, 10:00 UTC",
    ]);
    expect(
      describeRule(
        { type: "dateTime", from },
        createDateTimeText("Asia/Seoul"),
      ),
    ).toBe("From Oct 8, 2026, 19:00 GMT+9");
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

    const dateTime = createRule("dateTime") as { from?: string };
    expect(Date.parse(dateTime.from!)).toBeGreaterThan(Date.now());
    expect(new Date(dateTime.from!).getMinutes()).toBe(0);
    expect(ruleError(dateTime as never)).toBeNull();
    expect(ruleError({ type: "dateTime" })).toContain("start, an end");
    expect(
      ruleError({
        type: "dateTime",
        from: "2026-10-09T00:00:00.000Z",
        to: "2026-10-08T00:00:00.000Z",
      }),
    ).toBe("End after the start.");
  });

  it("offers quick starts and ends counted from the start, or from now", () => {
    const now = new Date(2026, 9, 8, 14, 25, 30);
    expect(
      startPresets(now).map(({ label, iso }) => [label, new Date(iso)]),
    ).toEqual([
      ["Now", new Date(2026, 9, 8, 14, 25)],
      ["Next hour", new Date(2026, 9, 8, 15, 0)],
      ["Tomorrow 09:00", new Date(2026, 9, 9, 9, 0)],
    ]);
    const start = new Date(2026, 9, 8, 15, 0).toISOString();
    expect(
      endPresets(start, now).map(({ label, iso }) => [label, new Date(iso)]),
    ).toEqual([
      ["+1 day", new Date(2026, 9, 9, 15, 0)],
      ["+1 week", new Date(2026, 9, 15, 15, 0)],
    ]);
    expect(new Date(endPresets(undefined, now)[0]!.iso)).toEqual(
      new Date(2026, 9, 9, 14, 25),
    );
  });

  it("names a condition after its rules, apart from the names in use", () => {
    const rules = [{ type: "channel", channels: ["beta"] }] as const;
    expect(suggestConditionName(rules, [])).toBe("Channel is beta");
    expect(suggestConditionName(rules, ["Channel is beta"])).toBe(
      "Channel is beta (2)",
    );
    expect(
      suggestConditionName(rules, ["Channel is beta", "Channel is beta (2)"]),
    ).toBe("Channel is beta (3)");
    expect(suggestConditionName([], [])).toBe("");
    const long = suggestConditionName(
      [{ type: "channel", channels: ["c".repeat(120)] }],
      [],
    );
    expect(long).toHaveLength(100);
    expect(long.endsWith("…")).toBe(true);
  });

  it("shows instants in the viewer's time zone and stores them in UTC", () => {
    const instant = "2026-10-08T10:30:00.000Z";
    const local = toLocalDateTimeInput(instant);
    expect(local).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u);
    expect(fromLocalDateTimeInput(local)).toBe(instant);
    expect(toLocalDateTimeInput(undefined)).toBe("");
    expect(fromLocalDateTimeInput("")).toBeUndefined();
  });

  it("splits lists on commas and lines", () => {
    expect(splitList(" beta, qa\nbeta,, ")).toEqual(["beta", "qa"]);
  });
});

describe("publish summary values", () => {
  it("lists each field a parameter changes, from before to after", () => {
    expect(
      describeParameterChange(
        {
          valueType: "STRING",
          defaultValue: { value: "Hello" },
          conditionalValues: { "QA cohort": { value: "qa" } },
        },
        {
          valueType: "STRING",
          defaultValue: { useInAppDefault: true },
          conditionalValues: { Default: { value: "" } },
          description: "Greeting",
        },
      ),
    ).toEqual([
      { field: "Default", before: "Hello", after: "In-app default" },
      { field: "When QA cohort", before: "qa", after: "Not set" },
      { field: "When Default", before: "Not set", after: '""' },
      { field: "Description", before: "Not set", after: "Greeting" },
    ]);
  });

  it("lists what an added parameter or condition sets, with no before", () => {
    expect(
      describeParameterChange(null, {
        valueType: "NUMBER",
        defaultValue: { value: "25" },
        conditionalValues: { QA: { useInAppDefault: true } },
      }),
    ).toEqual([
      { field: "Type", before: null, after: "Number" },
      { field: "Default", before: null, after: "25" },
      { field: "When QA", before: null, after: "In-app default" },
    ]);
    expect(
      describeConditionChange(null, {
        name: "QA",
        rules: [{ type: "cohort", cohorts: ["qa"] }],
      }),
    ).toEqual([
      {
        field: "Rules",
        before: null,
        after: describeRule({ type: "cohort", cohorts: ["qa"] }),
      },
    ]);
  });

  it("lists a condition's rules when they change, and nothing otherwise", () => {
    const qa: RemoteConfigCondition = {
      name: "QA",
      rules: [{ type: "cohort", cohorts: ["qa"] }],
    };
    expect(describeConditionChange(qa, qa)).toEqual([]);
    expect(
      describeConditionChange(qa, {
        name: "QA",
        rules: [{ type: "platform", platforms: ["ios"] }],
      }),
    ).toEqual([
      {
        field: "Rules",
        before: describeRule(qa.rules[0]!),
        after: describeRule({ type: "platform", platforms: ["ios"] }),
      },
    ]);
  });
});

describe("drafts kept in the browser", () => {
  const published = {
    version: 3,
    template: {
      conditions: [],
      parameters: {
        theme: { valueType: "STRING", defaultValue: { value: "light" } },
      },
    } satisfies RemoteConfigTemplate,
  };
  const edited: RemoteConfigTemplate = {
    conditions: [],
    parameters: {
      theme: { valueType: "STRING", defaultValue: { value: "dark" } },
    },
  };
  const items = new Map<string, string>();
  const useStorage = () =>
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => items.get(key) ?? null,
        setItem: (key: string, value: string) => items.set(key, value),
        removeItem: (key: string) => items.delete(key),
      },
    });

  afterEach(() => {
    items.clear();
    vi.unstubAllGlobals();
  });

  it("comes back only onto the version and template it started from", () => {
    useStorage();
    const draft = {
      baseVersion: 3,
      base: published.template,
      template: edited,
    };
    expect(storeDraft(draft)).toBe(true);
    expect(readStoredDraft(published)).toEqual(draft);
    expect(readStoredDraft({ ...published, version: 4 })).toBeNull();
    expect(
      readStoredDraft({
        version: 3,
        template: { conditions: [], parameters: {} },
      }),
    ).toBeNull();
    // A draft that publishes nothing new is not one.
    storeDraft({ ...draft, template: published.template });
    expect(readStoredDraft(published)).toBeNull();
    expect(storeDraft(null)).toBe(true);
    expect(readStoredDraft(published)).toBeNull();
  });

  it("ignores stored drafts it cannot render, and works without storage", () => {
    useStorage();
    for (const raw of [
      "{not json",
      JSON.stringify({ baseVersion: 3, base: published.template }),
      JSON.stringify({
        baseVersion: 3,
        base: published.template,
        template: {
          conditions: [{ name: "x", rules: [{ type: "country" }] }],
          parameters: {},
        },
      }),
      JSON.stringify({
        baseVersion: 3,
        base: published.template,
        template: {
          conditions: [],
          parameters: { a: { valueType: "STRING" } },
        },
      }),
    ]) {
      items.set("hot-updater:remote-config-draft", raw);
      expect(readStoredDraft(published)).toBeNull();
    }
    vi.unstubAllGlobals();
    // On the server, or where the browser refuses storage.
    expect(readStoredDraft(published)).toBeNull();
    expect(
      storeDraft({
        baseVersion: 3,
        base: published.template,
        template: edited,
      }),
    ).toBe(false);
  });
});

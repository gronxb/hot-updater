import { getRolledOutNumericCohorts } from "@hot-updater/protocol";
import { describe, expect, it } from "vitest";

import {
  evaluateRemoteConfig,
  REMOTE_CONFIG_MAX_TEMPLATE_LENGTH,
  type RemoteConfigTemplate,
  RemoteConfigValidationError,
  resolveRemoteConfigValues,
  validateRemoteConfigTemplate,
} from "./template";

const issuesOf = (input: unknown) => {
  try {
    validateRemoteConfigTemplate(input);
  } catch (error) {
    if (error instanceof RemoteConfigValidationError) return error.issues;
    throw error;
  }
  return [];
};

const template: RemoteConfigTemplate = {
  conditions: [
    { name: "Beta", rules: [{ type: "cohort", cohorts: ["beta"] }] },
    {
      name: "iOS 2.x",
      rules: [
        { type: "platform", platforms: ["ios"] },
        { type: "appVersion", range: "2.x" },
      ],
    },
  ],
  parameters: {
    welcome: {
      valueType: "STRING",
      defaultValue: { value: "Hello" },
      conditionalValues: {
        "iOS 2.x": { value: "Hello, iOS" },
        Beta: { value: "Hello, beta" },
      },
    },
    max_items: {
      valueType: "NUMBER",
      defaultValue: { useInAppDefault: true },
      conditionalValues: { "iOS 2.x": { value: "50" } },
    },
  },
};

describe("validateRemoteConfigTemplate", () => {
  it("returns a valid template with only its declared fields", () => {
    expect(validateRemoteConfigTemplate(template)).toEqual(template);
    expect(validateRemoteConfigTemplate({})).toEqual({
      conditions: [],
      parameters: {},
    });
  });

  it("normalizes cohorts and app version ranges", () => {
    expect(
      validateRemoteConfigTemplate({
        conditions: [
          {
            name: "Mixed",
            rules: [
              { type: "cohort", cohorts: ["007", "Beta", "beta"] },
              { type: "appVersion", range: " >=1.2.0 " },
            ],
          },
        ],
        parameters: {},
      }).conditions[0]!.rules,
    ).toEqual([
      { type: "cohort", cohorts: ["7", "beta"] },
      { type: "appVersion", range: ">=1.2.0" },
    ]);
  });

  it("reports every problem it finds, at its path", () => {
    expect(
      issuesOf({
        conditions: [
          { name: "A", rules: [] },
          {
            name: "A",
            rules: [{ type: "percent", seed: "s", from: 20, to: 10 }],
          },
          { name: "B", rules: [{ type: "appVersion", range: "not a range" }] },
          { name: "C", rules: [{ type: "platform", platforms: ["web"] }] },
        ],
        parameters: {
          "1bad": { valueType: "STRING", defaultValue: { value: "x" } },
          count: { valueType: "NUMBER", defaultValue: { value: "ten" } },
          on: { valueType: "BOOLEAN", defaultValue: { value: "yes" } },
          data: { valueType: "JSON", defaultValue: { value: "{" } },
          ghost: {
            valueType: "STRING",
            defaultValue: { value: "x" },
            conditionalValues: { Missing: { value: "y" } },
          },
          extra: {
            valueType: "STRING",
            defaultValue: { value: "x" },
            color: "red",
          },
        },
        version: 3,
      }).map(({ path }) => path),
    ).toEqual([
      "version",
      "conditions[0].rules",
      "conditions[1].name",
      "conditions[1].rules[0]",
      "conditions[2].rules[0].range",
      "conditions[3].rules[0].platforms[0]",
      "parameters.1bad",
      "parameters.count.defaultValue.value",
      "parameters.on.defaultValue.value",
      "parameters.data.defaultValue.value",
      "parameters.ghost.conditionalValues.Missing",
      "parameters.extra.color",
    ]);
  });

  it("refuses percentages finer than a tenth, and unknown rule fields", () => {
    expect(
      issuesOf({
        conditions: [
          {
            name: "Fine",
            rules: [{ type: "percent", seed: "s", from: 0, to: 10.05 }],
          },
          {
            name: "Typo",
            rules: [{ type: "channel", channels: ["beta"], channel: "beta" }],
          },
        ],
      }).map(({ path }) => path),
    ).toEqual(["conditions[0].rules[0]", "conditions[1].rules[0].channel"]);
  });

  it("keeps keys and condition names that Object.prototype also has", () => {
    // Parsed, as a request body is, so `__proto__` is an own key.
    const parsed = JSON.parse(`{
      "conditions": [
        { "name": "constructor", "rules": [{ "type": "platform", "platforms": ["ios"] }] },
        { "name": "__proto__", "rules": [{ "type": "platform", "platforms": ["ios"] }] }
      ],
      "parameters": {
        "__proto__": {
          "valueType": "STRING",
          "defaultValue": { "value": "own" },
          "conditionalValues": { "__proto__": { "value": "own on iOS" } }
        },
        "toString": { "valueType": "STRING", "defaultValue": { "value": "text" } }
      }
    }`);
    const valid = validateRemoteConfigTemplate(parsed);
    expect(Object.keys(valid.parameters)).toEqual(["__proto__", "toString"]);
    expect(Object.getPrototypeOf(valid.parameters)).toBe(Object.prototype);
    expect(JSON.parse(JSON.stringify(valid))).toEqual(parsed);
    // `constructor` matches first, but neither parameter has a value for it.
    expect(evaluateRemoteConfig(valid, { platform: "ios" })).toEqual(
      JSON.parse(`{
        "__proto__": { "value": "own on iOS", "condition": "__proto__" },
        "toString": { "value": "text", "condition": null }
      }`),
    );
  });

  it("reports a rule type that Object.prototype has as unknown", () => {
    expect(
      issuesOf({
        conditions: [{ name: "Odd", rules: [{ type: "constructor" }] }],
      }),
    ).toEqual([
      {
        path: "conditions[0].rules[0].type",
        message:
          "must be platform, channel, appVersion, cohort, percent, fingerprint, or dateTime.",
      },
    ]);
  });

  it("stores a parameter's description trimmed, and drops a blank one", () => {
    const parameters = validateRemoteConfigTemplate({
      parameters: {
        a: {
          valueType: "STRING",
          defaultValue: { value: "" },
          description: `  ${"d".repeat(256)}\n`,
        },
        b: {
          valueType: "STRING",
          defaultValue: { value: "" },
          description: "   ",
        },
      },
    }).parameters;
    expect(parameters.a!.description).toBe("d".repeat(256));
    expect(parameters.b).toEqual({
      valueType: "STRING",
      defaultValue: { value: "" },
    });
  });

  it("stores date-times in UTC, and refuses ones without a time zone or a range", () => {
    expect(
      validateRemoteConfigTemplate({
        conditions: [
          {
            name: "Sale",
            rules: [
              {
                type: "dateTime",
                from: "2026-10-08T19:00:00+09:00",
                to: "2026-10-09T10:00Z",
              },
            ],
          },
          {
            name: "After",
            rules: [{ type: "dateTime", from: "2026-10-08T10:00:00.5Z" }],
          },
        ],
      }).conditions.map(({ rules }) => rules[0]),
    ).toEqual([
      {
        type: "dateTime",
        from: "2026-10-08T10:00:00.000Z",
        to: "2026-10-09T10:00:00.000Z",
      },
      { type: "dateTime", from: "2026-10-08T10:00:00.500Z" },
    ]);
    expect(
      issuesOf({
        conditions: [
          {
            name: "Local",
            rules: [{ type: "dateTime", from: "2026-10-08T10:00" }],
          },
          { name: "Open", rules: [{ type: "dateTime" }] },
          {
            name: "Backwards",
            rules: [
              {
                type: "dateTime",
                from: "2026-10-09T00:00:00Z",
                to: "2026-10-08T00:00:00Z",
              },
            ],
          },
        ],
      }).map(({ path }) => path),
    ).toEqual([
      "conditions[0].rules[0].from",
      "conditions[1].rules[0]",
      "conditions[2].rules[0]",
    ]);
  });

  it("caps a template's JSON so a device can store its values", () => {
    const issues = issuesOf({
      parameters: {
        big: {
          valueType: "STRING",
          defaultValue: {
            value: "x".repeat(REMOTE_CONFIG_MAX_TEMPLATE_LENGTH),
          },
        },
      },
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain("the limit is 60,000");
  });
});

describe("evaluateRemoteConfig", () => {
  const device = {
    platform: "ios",
    appVersion: "2.3.0",
    channel: "production",
    cohort: "beta",
    fingerprintHash: null,
  } as const;

  it("takes the first matching condition in the template's order", () => {
    // Beta is listed first, so it wins over iOS 2.x for `welcome`.
    expect(evaluateRemoteConfig(template, device)).toEqual({
      welcome: { value: "Hello, beta", condition: "Beta" },
      max_items: { value: "50", condition: "iOS 2.x" },
    });
  });

  it("falls back to the default value, and leaves in-app defaults out of what devices receive", () => {
    const android = { ...device, platform: "android", cohort: "12" } as const;
    expect(evaluateRemoteConfig(template, android)).toEqual({
      welcome: { value: "Hello", condition: null },
      max_items: { value: null, condition: null },
    });
    expect(resolveRemoteConfigValues(template, android)).toEqual({
      welcome: "Hello",
    });
  });

  it("never matches a rule on a field the device did not send", () => {
    expect(
      resolveRemoteConfigValues(template, { platform: "ios", cohort: "1" }),
    ).toEqual({ welcome: "Hello" });
  });

  it("splits numeric cohorts into disjoint, stable percentage ranges per seed", () => {
    const share = (from: number, to: number, seed = "rollout") => {
      const rollout: RemoteConfigTemplate = {
        conditions: [
          { name: "Share", rules: [{ type: "percent", seed, from, to }] },
        ],
        parameters: {
          on: {
            valueType: "BOOLEAN",
            defaultValue: { value: "false" },
            conditionalValues: { Share: { value: "true" } },
          },
        },
      };
      return Array.from({ length: 1000 }, (_, index) =>
        String(index + 1),
      ).filter(
        (cohort) =>
          resolveRemoteConfigValues(rollout, { cohort }).on === "true",
      );
    };
    const first = share(0, 10);
    const second = share(10, 20);
    expect(first).toHaveLength(100);
    expect(second).toHaveLength(100);
    expect(first.filter((cohort) => second.includes(cohort))).toEqual([]);
    expect(share(0, 10)).toEqual(first);
    expect(share(0, 10, "other")).not.toEqual(first);
    expect(share(0, 100)).toHaveLength(1000);
    expect(share(0, 0.1)).toHaveLength(1);

    // Widening keeps the installations already in, as a bundle rollout of
    // the same share and seed picks them.
    const widened = share(0, 25);
    expect(first.every((cohort) => widened.includes(cohort))).toBe(true);
    expect(widened.map(Number).toSorted((a, b) => a - b)).toEqual(
      getRolledOutNumericCohorts("rollout", 250),
    );
  });

  it("matches a date-time range on the clock it is given, ends open or not", () => {
    const scheduled: RemoteConfigTemplate = {
      conditions: [
        {
          name: "Sale",
          rules: [
            {
              type: "dateTime",
              from: "2026-10-08T10:00:00.000Z",
              to: "2026-10-09T10:00:00.000Z",
            },
          ],
        },
        {
          name: "Later",
          rules: [{ type: "dateTime", from: "2026-10-09T10:00:00.000Z" }],
        },
      ],
      parameters: {
        banner: {
          valueType: "STRING",
          defaultValue: { value: "none" },
          conditionalValues: {
            Sale: { value: "sale" },
            Later: { value: "later" },
          },
        },
      },
    };
    const at = (iso: string) =>
      resolveRemoteConfigValues(scheduled, { now: Date.parse(iso) }).banner;
    expect(at("2026-10-08T09:59:59.999Z")).toBe("none");
    expect(at("2026-10-08T10:00:00.000Z")).toBe("sale");
    expect(at("2026-10-09T09:59:59.999Z")).toBe("sale");
    expect(at("2026-10-09T10:00:00.000Z")).toBe("later");
    // A context without a clock matches no date-time rule.
    expect(resolveRemoteConfigValues(scheduled, {}).banner).toBe("none");
  });

  it("matches custom cohorts only by name, never by percentage", () => {
    const everyone: RemoteConfigTemplate = {
      conditions: [
        {
          name: "All",
          rules: [{ type: "percent", seed: "s", from: 0, to: 100 }],
        },
      ],
      parameters: {
        on: {
          valueType: "STRING",
          defaultValue: { value: "no" },
          conditionalValues: { All: { value: "yes" } },
        },
      },
    };
    expect(resolveRemoteConfigValues(everyone, { cohort: "qa" })).toEqual({
      on: "no",
    });
    expect(resolveRemoteConfigValues(everyone, { cohort: "500" })).toEqual({
      on: "yes",
    });
  });

  it("matches channels and fingerprints exactly", () => {
    const targeted: RemoteConfigTemplate = {
      conditions: [
        {
          name: "Build",
          rules: [
            { type: "channel", channels: ["beta"] },
            { type: "fingerprint", hashes: ["abc"] },
          ],
        },
      ],
      parameters: {
        mode: {
          valueType: "STRING",
          defaultValue: { value: "stable" },
          conditionalValues: { Build: { value: "next" } },
        },
      },
    };
    expect(
      resolveRemoteConfigValues(targeted, {
        channel: "beta",
        fingerprintHash: "abc",
      }),
    ).toEqual({ mode: "next" });
    expect(
      resolveRemoteConfigValues(targeted, {
        channel: "beta",
        fingerprintHash: "abcd",
      }),
    ).toEqual({ mode: "stable" });
  });
});

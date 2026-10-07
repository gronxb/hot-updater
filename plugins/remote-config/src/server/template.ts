import { semverSatisfies } from "@hot-updater/plugin-core";
import {
  getNumericCohortRolloutPosition,
  getNumericCohortValue,
  isValidCohort,
  normalizeCohortValue,
} from "@hot-updater/protocol";
import { isValidRange } from "verkit";

import type { RemoteConfigDeviceContext } from "../shared/wire";

/**
 * How the Console edits a parameter's value and checks it before a publish.
 * Devices receive every value as text, as in Firebase Remote Config.
 */
export type RemoteConfigValueType = "STRING" | "NUMBER" | "BOOLEAN" | "JSON";

/** A value a parameter takes: text, or the app's own default. */
export type RemoteConfigParameterValue =
  | { readonly value: string }
  | { readonly useInAppDefault: true };

export interface RemoteConfigParameter {
  readonly valueType: RemoteConfigValueType;
  /** The value when none of the parameter's conditions match. */
  readonly defaultValue: RemoteConfigParameterValue;
  /**
   * Values by condition name. When several of these conditions match, the
   * one listed first in the template's `conditions` wins.
   */
  readonly conditionalValues?: Readonly<
    Record<string, RemoteConfigParameterValue>
  >;
  readonly description?: string;
}

/** A test on a device's context; a condition matches when all of its rules do. */
export type RemoteConfigRule =
  | {
      readonly type: "platform";
      readonly platforms: readonly ("ios" | "android")[];
    }
  | { readonly type: "channel"; readonly channels: readonly string[] }
  /** A semver range, such as `>=1.4.0` or `2.x`, as release targets use. */
  | { readonly type: "appVersion"; readonly range: string }
  /** Devices whose cohort is one of these: numbers from 1 to 1000 or slugs. */
  | { readonly type: "cohort"; readonly cohorts: readonly string[] }
  /**
   * A share of numeric cohorts: the devices whose cohort lands in
   * `[from, to)` percent once `seed` shuffles the 1,000 cohorts. Rules with
   * one seed pick from one order, so `0–10` and `10–20` never overlap; a new
   * seed picks other devices. Custom cohorts never match.
   */
  | {
      readonly type: "percent";
      readonly seed: string;
      readonly from: number;
      readonly to: number;
    }
  | { readonly type: "fingerprint"; readonly hashes: readonly string[] };

export type RemoteConfigRuleType = RemoteConfigRule["type"];

export interface RemoteConfigCondition {
  /** Unique in the template; parameters name it in `conditionalValues`. */
  readonly name: string;
  /** Every rule must match. */
  readonly rules: readonly RemoteConfigRule[];
}

/**
 * Everything Remote Config serves, published as a whole and versioned, as
 * a Firebase Remote Config template is.
 */
export interface RemoteConfigTemplate {
  /** In priority order: the first one that matches decides a parameter's value. */
  readonly conditions: readonly RemoteConfigCondition[];
  readonly parameters: Readonly<Record<string, RemoteConfigParameter>>;
}

export const EMPTY_REMOTE_CONFIG_TEMPLATE: RemoteConfigTemplate = Object.freeze(
  { conditions: Object.freeze([]), parameters: Object.freeze({}) },
);

/**
 * A template's JSON stays under this many characters, so a device's values
 * always fit the 64 KB a client plugin may store under one key.
 */
export const REMOTE_CONFIG_MAX_TEMPLATE_LENGTH = 60_000;
export const REMOTE_CONFIG_MAX_PARAMETERS = 2000;
export const REMOTE_CONFIG_MAX_CONDITIONS = 500;
const MAX_RULE_VALUES = 100;
const MAX_DESCRIPTION_LENGTH = 256;
const MAX_CONDITION_NAME_LENGTH = 100;
const MAX_RULE_TEXT_LENGTH = 128;

const PARAMETER_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,255}$/u;
const SEED_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;
const VALUE_TYPES: ReadonlySet<string> = new Set([
  "STRING",
  "NUMBER",
  "BOOLEAN",
  "JSON",
]);
const PLATFORMS: ReadonlySet<string> = new Set(["ios", "android"]);

/** One problem with a template, at a JSON path such as `parameters.welcome.defaultValue`. */
export interface RemoteConfigTemplateIssue {
  readonly path: string;
  readonly message: string;
}

/** A template that cannot be published; `issues` lists every problem found. */
export class RemoteConfigValidationError extends Error {
  override readonly name = "RemoteConfigValidationError";

  constructor(readonly issues: readonly RemoteConfigTemplateIssue[]) {
    super(
      `The Remote Config template is invalid: ${issues
        .slice(0, 3)
        .map(({ path, message }) => (path ? `${path}: ${message}` : message))
        .join("; ")}${issues.length > 3 ? ` (and ${issues.length - 3} more)` : ""}`,
    );
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const visibleText = (value: unknown, max: number): value is string =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.length <= max &&
  !/[\p{Cc}]/u.test(value);

/** Whether a value's text suits its type; the problem otherwise. */
const checkValueText = (
  valueType: RemoteConfigValueType,
  text: string,
): string | null => {
  switch (valueType) {
    case "NUMBER":
      return text.trim().length > 0 && Number.isFinite(Number(text))
        ? null
        : "must be a number.";
    case "BOOLEAN":
      return text === "true" || text === "false"
        ? null
        : 'must be "true" or "false".';
    case "JSON":
      try {
        JSON.parse(text);
        return null;
      } catch {
        return "must be valid JSON.";
      }
    default:
      return null;
  }
};

/**
 * Checks a template and returns it with only its declared fields, or throws
 * `RemoteConfigValidationError` with every problem it finds.
 */
export const validateRemoteConfigTemplate = (
  input: unknown,
): RemoteConfigTemplate => {
  const issues: RemoteConfigTemplateIssue[] = [];
  const issue = (path: string, message: string) => {
    issues.push({ path, message });
  };
  const unknownKeys = (
    value: Record<string, unknown>,
    allowed: readonly string[],
    path: string,
  ) => {
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) {
        issue(path ? `${path}.${key}` : key, "is not a template field.");
      }
    }
  };

  if (!isRecord(input)) {
    throw new RemoteConfigValidationError([
      { path: "", message: "A template is an object." },
    ]);
  }
  unknownKeys(input, ["conditions", "parameters"], "");

  const conditions: RemoteConfigCondition[] = [];
  const conditionNames = new Set<string>();
  const rawConditions = input.conditions ?? [];
  if (!Array.isArray(rawConditions)) {
    issue("conditions", "must be a list.");
  } else {
    if (rawConditions.length > REMOTE_CONFIG_MAX_CONDITIONS) {
      issue(
        "conditions",
        `holds at most ${REMOTE_CONFIG_MAX_CONDITIONS} conditions.`,
      );
    }
    rawConditions.forEach((raw: unknown, index) => {
      const path = `conditions[${index}]`;
      if (!isRecord(raw)) {
        issue(path, "must be an object.");
        return;
      }
      unknownKeys(raw, ["name", "rules"], path);
      const { name } = raw;
      if (!visibleText(name, MAX_CONDITION_NAME_LENGTH)) {
        issue(
          `${path}.name`,
          `must be 1-${MAX_CONDITION_NAME_LENGTH} visible characters.`,
        );
      } else if (conditionNames.has(name)) {
        issue(`${path}.name`, `"${name}" names another condition too.`);
      } else {
        conditionNames.add(name);
      }
      const rules = validateRules(raw.rules, `${path}.rules`, issue);
      if (typeof name === "string") conditions.push({ name, rules });
    });
  }

  const parameters: Record<string, RemoteConfigParameter> = {};
  const rawParameters = input.parameters ?? {};
  if (!isRecord(rawParameters)) {
    issue("parameters", "must be an object keyed by parameter.");
  } else {
    const keys = Object.keys(rawParameters);
    if (keys.length > REMOTE_CONFIG_MAX_PARAMETERS) {
      issue(
        "parameters",
        `holds at most ${REMOTE_CONFIG_MAX_PARAMETERS} parameters.`,
      );
    }
    for (const key of keys) {
      const path = `parameters.${key}`;
      if (!PARAMETER_KEY_PATTERN.test(key)) {
        issue(
          path,
          "Parameter keys start with a letter or _, and hold up to 256 letters, digits, and _.",
        );
      }
      const raw = rawParameters[key];
      if (!isRecord(raw)) {
        issue(path, "must be an object.");
        continue;
      }
      unknownKeys(
        raw,
        ["valueType", "defaultValue", "conditionalValues", "description"],
        path,
      );
      const valueType = raw.valueType;
      if (typeof valueType !== "string" || !VALUE_TYPES.has(valueType)) {
        issue(
          `${path}.valueType`,
          "must be STRING, NUMBER, BOOLEAN, or JSON.",
        );
        continue;
      }
      const type = valueType as RemoteConfigValueType;
      const readValue = (
        value: unknown,
        valuePath: string,
      ): RemoteConfigParameterValue | null => {
        if (!isRecord(value)) {
          issue(valuePath, "must be { value } or { useInAppDefault: true }.");
          return null;
        }
        if ("useInAppDefault" in value) {
          unknownKeys(value, ["useInAppDefault"], valuePath);
          if (value.useInAppDefault !== true) {
            issue(`${valuePath}.useInAppDefault`, "must be true.");
            return null;
          }
          return { useInAppDefault: true };
        }
        unknownKeys(value, ["value"], valuePath);
        if (typeof value.value !== "string") {
          issue(`${valuePath}.value`, "must be text.");
          return null;
        }
        const problem = checkValueText(type, value.value);
        if (problem !== null) {
          issue(`${valuePath}.value`, problem);
          return null;
        }
        return { value: value.value };
      };
      const defaultValue = readValue(
        raw.defaultValue,
        `${path}.defaultValue`,
      );
      const conditionalValues: Record<string, RemoteConfigParameterValue> =
        {};
      if (raw.conditionalValues !== undefined) {
        if (!isRecord(raw.conditionalValues)) {
          issue(
            `${path}.conditionalValues`,
            "must be an object keyed by condition.",
          );
        } else {
          for (const [conditionName, value] of Object.entries(
            raw.conditionalValues,
          )) {
            const valuePath = `${path}.conditionalValues.${conditionName}`;
            if (!conditionNames.has(conditionName)) {
              issue(valuePath, `No condition is named "${conditionName}".`);
              continue;
            }
            const read = readValue(value, valuePath);
            if (read !== null) conditionalValues[conditionName] = read;
          }
        }
      }
      let description: string | undefined;
      if (raw.description !== undefined && raw.description !== "") {
        if (
          typeof raw.description !== "string" ||
          raw.description.length > MAX_DESCRIPTION_LENGTH
        ) {
          issue(
            `${path}.description`,
            `must be text of up to ${MAX_DESCRIPTION_LENGTH} characters.`,
          );
        } else {
          description = raw.description;
        }
      }
      if (defaultValue !== null) {
        parameters[key] = {
          valueType: type,
          defaultValue,
          ...(Object.keys(conditionalValues).length === 0
            ? {}
            : { conditionalValues }),
          ...(description === undefined ? {} : { description }),
        };
      }
    }
  }

  if (issues.length > 0) throw new RemoteConfigValidationError(issues);
  const template: RemoteConfigTemplate = { conditions, parameters };
  const length = JSON.stringify(template).length;
  if (length > REMOTE_CONFIG_MAX_TEMPLATE_LENGTH) {
    throw new RemoteConfigValidationError([
      {
        path: "",
        message: `The template takes ${length.toLocaleString("en-US")} characters of JSON; the limit is ${REMOTE_CONFIG_MAX_TEMPLATE_LENGTH.toLocaleString("en-US")}.`,
      },
    ]);
  }
  return template;
};

const textList = (
  value: unknown,
  path: string,
  issue: (path: string, message: string) => void,
  check: (text: string) => boolean,
  describe: string,
): string[] => {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_RULE_VALUES
  ) {
    issue(path, `must list 1-${MAX_RULE_VALUES} values.`);
    return [];
  }
  const list: string[] = [];
  value.forEach((entry: unknown, index) => {
    if (typeof entry !== "string" || !check(entry)) {
      issue(`${path}[${index}]`, describe);
    } else if (!list.includes(entry)) {
      list.push(entry);
    }
  });
  return list;
};

const RULE_FIELDS: Readonly<Record<RemoteConfigRuleType, readonly string[]>> =
  {
    platform: ["type", "platforms"],
    channel: ["type", "channels"],
    appVersion: ["type", "range"],
    cohort: ["type", "cohorts"],
    percent: ["type", "seed", "from", "to"],
    fingerprint: ["type", "hashes"],
  };

const validateRules = (
  value: unknown,
  path: string,
  issue: (path: string, message: string) => void,
): RemoteConfigRule[] => {
  if (!Array.isArray(value) || value.length === 0) {
    issue(path, "must list at least one rule.");
    return [];
  }
  const rules: RemoteConfigRule[] = [];
  value.forEach((raw: unknown, index) => {
    const rulePath = `${path}[${index}]`;
    if (!isRecord(raw) || typeof raw.type !== "string") {
      issue(rulePath, "must be a rule object with a type.");
      return;
    }
    const type = raw.type as RemoteConfigRuleType;
    const fields = RULE_FIELDS[type];
    if (fields === undefined) {
      issue(
        `${rulePath}.type`,
        "must be platform, channel, appVersion, cohort, percent, or fingerprint.",
      );
      return;
    }
    for (const key of Object.keys(raw)) {
      if (!fields.includes(key)) {
        issue(`${rulePath}.${key}`, `is not a field of a ${type} rule.`);
      }
    }
    switch (type) {
      case "platform": {
        const platforms = textList(
          raw.platforms,
          `${rulePath}.platforms`,
          issue,
          (text) => PLATFORMS.has(text),
          'must be "ios" or "android".',
        ) as ("ios" | "android")[];
        rules.push({ type, platforms });
        return;
      }
      case "channel": {
        const channels = textList(
          raw.channels,
          `${rulePath}.channels`,
          issue,
          (text) => visibleText(text, MAX_RULE_TEXT_LENGTH),
          `must be a channel name of 1-${MAX_RULE_TEXT_LENGTH} characters.`,
        );
        rules.push({ type, channels });
        return;
      }
      case "appVersion": {
        const range = raw.range;
        if (
          !visibleText(range, MAX_RULE_TEXT_LENGTH) ||
          !isValidRange(range.trim())
        ) {
          issue(
            `${rulePath}.range`,
            "must be a semver range, such as >=1.4.0 or 2.x.",
          );
          return;
        }
        rules.push({ type, range: range.trim() });
        return;
      }
      case "cohort": {
        const cohorts = textList(
          raw.cohorts,
          `${rulePath}.cohorts`,
          issue,
          isValidCohort,
          "must be a cohort from 1 to 1000, or a lowercase slug.",
        ).map(normalizeCohortValue);
        rules.push({ type, cohorts: [...new Set(cohorts)] });
        return;
      }
      case "percent": {
        const { seed, from, to } = raw;
        if (typeof seed !== "string" || !SEED_PATTERN.test(seed)) {
          issue(
            `${rulePath}.seed`,
            "must be 1-64 letters, digits, _, and -.",
          );
          return;
        }
        // Tenths of a percent: one numeric cohort each.
        const isPercent = (value: unknown): value is number =>
          typeof value === "number" &&
          value >= 0 &&
          value <= 100 &&
          Math.abs(value * 10 - Math.round(value * 10)) < 1e-9;
        if (!isPercent(from) || !isPercent(to) || from >= to) {
          issue(
            rulePath,
            "takes from < to, each a percentage from 0 to 100 in steps of 0.1.",
          );
          return;
        }
        rules.push({ type, seed, from, to });
        return;
      }
      case "fingerprint": {
        const hashes = textList(
          raw.hashes,
          `${rulePath}.hashes`,
          issue,
          (text) => visibleText(text, MAX_RULE_TEXT_LENGTH),
          `must be a fingerprint of 1-${MAX_RULE_TEXT_LENGTH} characters.`,
        );
        rules.push({ type, hashes });
        return;
      }
    }
  });
  return rules;
};

/** What the server knows of a device; a rule on a missing field never matches. */
export type RemoteConfigEvaluationContext = Partial<
  Readonly<{
    [K in keyof RemoteConfigDeviceContext]: RemoteConfigDeviceContext[K] | null;
  }>
>;

/** Whether one rule matches a device. */
export const matchesRemoteConfigRule = (
  rule: RemoteConfigRule,
  context: RemoteConfigEvaluationContext,
): boolean => {
  switch (rule.type) {
    case "platform":
      return (
        context.platform !== undefined &&
        context.platform !== null &&
        rule.platforms.includes(context.platform)
      );
    case "channel":
      return (
        typeof context.channel === "string" &&
        rule.channels.includes(context.channel)
      );
    case "appVersion":
      return (
        typeof context.appVersion === "string" &&
        semverSatisfies(rule.range, context.appVersion)
      );
    case "cohort":
      return (
        typeof context.cohort === "string" &&
        rule.cohorts.includes(normalizeCohortValue(context.cohort))
      );
    case "percent": {
      if (typeof context.cohort !== "string") return false;
      const cohort = getNumericCohortValue(context.cohort);
      if (cohort === null) return false;
      // 0-999: where the seed's shuffle puts the cohort, in tenths of a percent.
      const position = getNumericCohortRolloutPosition(rule.seed, cohort);
      return (
        position >= Math.round(rule.from * 10) &&
        position < Math.round(rule.to * 10)
      );
    }
    case "fingerprint":
      return (
        typeof context.fingerprintHash === "string" &&
        rule.hashes.includes(context.fingerprintHash)
      );
  }
};

/** Whether every rule of a condition matches a device. */
export const matchesRemoteConfigCondition = (
  condition: RemoteConfigCondition,
  context: RemoteConfigEvaluationContext,
): boolean =>
  condition.rules.every((rule) => matchesRemoteConfigRule(rule, context));

/** A parameter's value for one device, and the condition that chose it. */
export interface RemoteConfigEvaluatedParameter {
  /** The text the device receives, or null when it keeps its in-app default. */
  readonly value: string | null;
  /** The condition whose value applies, or null for the default value. */
  readonly condition: string | null;
}

/**
 * Every parameter's value for one device: the value of the first condition,
 * in the template's order, that matches and that the parameter has a value
 * for; otherwise its default value.
 */
export const evaluateRemoteConfig = (
  template: RemoteConfigTemplate,
  context: RemoteConfigEvaluationContext,
): Record<string, RemoteConfigEvaluatedParameter> => {
  const matched = template.conditions
    .filter((condition) => matchesRemoteConfigCondition(condition, context))
    .map(({ name }) => name);
  const result: Record<string, RemoteConfigEvaluatedParameter> = {};
  for (const [key, parameter] of Object.entries(template.parameters)) {
    const condition = matched.find(
      (name) => parameter.conditionalValues?.[name] !== undefined,
    );
    const chosen =
      condition === undefined
        ? parameter.defaultValue
        : parameter.conditionalValues![condition]!;
    result[key] = {
      value: "value" in chosen ? chosen.value : null,
      condition: condition ?? null,
    };
  }
  return result;
};

/** The values a device receives: each parameter's text, without in-app defaults. */
export const resolveRemoteConfigValues = (
  template: RemoteConfigTemplate,
  context: RemoteConfigEvaluationContext,
): Record<string, string> => {
  const values: Record<string, string> = {};
  for (const [key, { value }] of Object.entries(
    evaluateRemoteConfig(template, context),
  )) {
    if (value !== null) values[key] = value;
  }
  return values;
};

import type {
  RemoteConfigCondition,
  RemoteConfigParameter,
  RemoteConfigParameterValue,
  RemoteConfigRule,
  RemoteConfigRuleType,
  RemoteConfigTemplate,
  RemoteConfigValueType,
} from "@hot-updater/server/plugins/remote-config";

/**
 * The edits the Remote Config page makes to a draft template before a
 * publish. Each returns a new template; the server validates the whole one
 * again when it is published.
 */

export type {
  RemoteConfigCondition,
  RemoteConfigParameter,
  RemoteConfigParameterValue,
  RemoteConfigRule,
  RemoteConfigRuleType,
  RemoteConfigTemplate,
  RemoteConfigValueType,
};

export const EMPTY_TEMPLATE: RemoteConfigTemplate = {
  conditions: [],
  parameters: {},
};

export const VALUE_TYPE_LABELS: Readonly<
  Record<RemoteConfigValueType, string>
> = {
  STRING: "String",
  NUMBER: "Number",
  BOOLEAN: "Boolean",
  JSON: "JSON",
};

export const RULE_TYPE_LABELS: Readonly<Record<RemoteConfigRuleType, string>> =
  {
    platform: "Platform",
    channel: "Channel",
    appVersion: "App version",
    percent: "Percentage of installs",
    cohort: "Cohort",
    fingerprint: "Fingerprint",
  };

/** Whether two templates publish the same thing. */
export const isSameTemplate = (
  left: RemoteConfigTemplate,
  right: RemoteConfigTemplate,
): boolean => JSON.stringify(left) === JSON.stringify(right);

/** Adds a parameter, or replaces `previousKey`'s in its place. */
export const upsertParameter = (
  template: RemoteConfigTemplate,
  previousKey: string | null,
  key: string,
  parameter: RemoteConfigParameter,
): RemoteConfigTemplate => {
  const entries = Object.entries(template.parameters);
  const index =
    previousKey === null
      ? -1
      : entries.findIndex(([existing]) => existing === previousKey);
  const next: [string, RemoteConfigParameter][] =
    index === -1
      ? [...entries.filter(([existing]) => existing !== key), [key, parameter]]
      : entries.map((entry, position) =>
          position === index ? [key, parameter] : entry,
        );
  return { ...template, parameters: Object.fromEntries(next) };
};

export const removeParameter = (
  template: RemoteConfigTemplate,
  key: string,
): RemoteConfigTemplate => ({
  ...template,
  parameters: Object.fromEntries(
    Object.entries(template.parameters).filter(
      ([existing]) => existing !== key,
    ),
  ),
});

/** Every parameter's conditional values, with `rename` applied to their condition names. */
const mapConditionalValues = (
  template: RemoteConfigTemplate,
  rename: (name: string) => string | null,
): RemoteConfigTemplate["parameters"] =>
  Object.fromEntries(
    Object.entries(template.parameters).map(([key, parameter]) => {
      const { conditionalValues, ...rest } = parameter;
      const kept = Object.entries(conditionalValues ?? {}).flatMap(
        ([name, value]) => {
          const next = rename(name);
          return next === null ? [] : [[next, value] as const];
        },
      );
      return [
        key,
        kept.length === 0
          ? rest
          : { ...rest, conditionalValues: Object.fromEntries(kept) },
      ];
    }),
  );

/**
 * Adds a condition last, or replaces `previousName`'s in its place; a
 * rename carries the parameters' values for it to the new name.
 */
export const upsertCondition = (
  template: RemoteConfigTemplate,
  previousName: string | null,
  condition: RemoteConfigCondition,
): RemoteConfigTemplate => {
  if (previousName === null) {
    return { ...template, conditions: [...template.conditions, condition] };
  }
  return {
    conditions: template.conditions.map((existing) =>
      existing.name === previousName ? condition : existing,
    ),
    parameters:
      previousName === condition.name
        ? template.parameters
        : mapConditionalValues(template, (name) =>
            name === previousName ? condition.name : name,
          ),
  };
};

/** Removes a condition and every parameter's value for it. */
export const removeCondition = (
  template: RemoteConfigTemplate,
  name: string,
): RemoteConfigTemplate => ({
  conditions: template.conditions.filter(
    (condition) => condition.name !== name,
  ),
  parameters: mapConditionalValues(template, (existing) =>
    existing === name ? null : existing,
  ),
});

/** Moves a condition up (`-1`) or down (`1`) in priority. */
export const moveCondition = (
  template: RemoteConfigTemplate,
  index: number,
  offset: -1 | 1,
): RemoteConfigTemplate => {
  const target = index + offset;
  if (target < 0 || target >= template.conditions.length) return template;
  const conditions = [...template.conditions];
  [conditions[index], conditions[target]] = [
    conditions[target]!,
    conditions[index]!,
  ];
  return { ...template, conditions };
};

/** The parameters that give a condition a value. */
export const parametersUsing = (
  template: RemoteConfigTemplate,
  name: string,
): string[] =>
  Object.entries(template.parameters)
    .filter(
      ([, parameter]) => parameter.conditionalValues?.[name] !== undefined,
    )
    .map(([key]) => key);

const listText = (values: readonly string[], limit = 3): string =>
  values.length <= limit
    ? values.join(", ")
    : `${values.slice(0, limit).join(", ")} +${values.length - limit}`;

const percentText = (value: number) =>
  Number.isInteger(value) ? String(value) : value.toFixed(1);

/** A rule in a few words, such as `Channel is beta, qa`. */
export const describeRule = (rule: RemoteConfigRule): string => {
  switch (rule.type) {
    case "platform":
      return `Platform is ${listText(
        rule.platforms.map((platform) =>
          platform === "ios" ? "iOS" : "Android",
        ),
      )}`;
    case "channel":
      return `Channel is ${listText(rule.channels)}`;
    case "appVersion":
      return `App version ${rule.range}`;
    case "cohort":
      return `Cohort is ${listText(rule.cohorts)}`;
    case "percent":
      return rule.from === 0
        ? `${percentText(rule.to)}% of installs`
        : `${percentText(rule.from)}–${percentText(rule.to)}% of installs`;
    case "fingerprint":
      return `Fingerprint is ${listText(
        rule.hashes.map((hash) => hash.slice(0, 8)),
      )}`;
  }
};

/** A value as the page shows it: its text, or the app's own default. */
export const describeValue = (value: RemoteConfigParameterValue): string =>
  "value" in value
    ? value.value.length === 0
      ? '""'
      : value.value
    : "In-app default";

/** A short random seed, so a new percentage rule picks its own installs. */
export const createSeed = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (byte) => byte.toString(36).padStart(2, "0"))
    .join("")
    .slice(0, 8);
};

/** The parameter and condition keys that a draft adds, changes, or removes. */
export interface TemplateChanges {
  readonly added: readonly string[];
  readonly changed: readonly string[];
  readonly removed: readonly string[];
}

const diffKeys = <T>(
  base: Readonly<Record<string, T>>,
  draft: Readonly<Record<string, T>>,
): TemplateChanges => ({
  added: Object.keys(draft).filter((key) => !(key in base)),
  changed: Object.keys(draft).filter(
    (key) =>
      key in base && JSON.stringify(base[key]) !== JSON.stringify(draft[key]),
  ),
  removed: Object.keys(base).filter((key) => !(key in draft)),
});

/** What a publish changes, for the publish dialog. */
export const summarizeChanges = (
  base: RemoteConfigTemplate,
  draft: RemoteConfigTemplate,
): {
  readonly parameters: TemplateChanges;
  readonly conditions: TemplateChanges;
  /** The conditions' priority order changed. */
  readonly reordered: boolean;
} => {
  const byName = (template: RemoteConfigTemplate) =>
    Object.fromEntries(
      template.conditions.map((condition) => [condition.name, condition]),
    );
  const kept = (template: RemoteConfigTemplate, other: RemoteConfigTemplate) =>
    template.conditions
      .map(({ name }) => name)
      .filter((name) => other.conditions.some((it) => it.name === name));
  return {
    parameters: diffKeys(base.parameters, draft.parameters),
    conditions: diffKeys(byName(base), byName(draft)),
    reordered: kept(base, draft).join("\n") !== kept(draft, base).join("\n"),
  };
};

const PARAMETER_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,255}$/u;

/** Why a parameter key cannot be used, or null. */
export const parameterKeyError = (
  key: string,
  taken: readonly string[],
): string | null => {
  if (key.length === 0) return "Enter a key.";
  if (!PARAMETER_KEY_PATTERN.test(key)) {
    return "Start with a letter or _, then use letters, digits, and _.";
  }
  return taken.includes(key) ? "Another parameter uses this key." : null;
};

/** Why a value's text does not suit its type, or null. */
export const valueTextError = (
  valueType: RemoteConfigValueType,
  text: string,
): string | null => {
  if (valueType === "NUMBER") {
    return text.trim().length > 0 && Number.isFinite(Number(text))
      ? null
      : "Enter a number.";
  }
  if (valueType === "JSON") {
    try {
      JSON.parse(text);
      return null;
    } catch {
      return "Enter valid JSON.";
    }
  }
  if (valueType === "BOOLEAN" && text !== "true" && text !== "false") {
    return "Choose true or false.";
  }
  return null;
};

/** Why a condition name cannot be used, or null. */
export const conditionNameError = (
  name: string,
  taken: readonly string[],
): string | null => {
  const trimmed = name.trim();
  if (trimmed.length === 0) return "Enter a name.";
  if (trimmed.length > 100) return "Use 100 characters or fewer.";
  return taken.includes(trimmed) ? "Another condition uses this name." : null;
};

/** Splits a comma- or newline-separated list, without blanks or repeats. */
export const splitList = (text: string): string[] => [
  ...new Set(
    text
      .split(/[\n,]/u)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  ),
];

/** The problem with a rule, for its editor; null when the server would take it. */
export const ruleError = (rule: RemoteConfigRule): string | null => {
  switch (rule.type) {
    case "platform":
      return rule.platforms.length === 0 ? "Choose a platform." : null;
    case "channel":
      return rule.channels.length === 0 ? "Enter a channel." : null;
    case "appVersion":
      return rule.range.trim().length === 0
        ? "Enter a version range, such as >=1.4.0."
        : null;
    case "cohort":
      return rule.cohorts.length === 0 ? "Enter a cohort." : null;
    case "percent":
      return rule.from >= rule.to ||
        rule.from < 0 ||
        rule.to > 100 ||
        Math.abs(rule.to * 10 - Math.round(rule.to * 10)) > 1e-9 ||
        Math.abs(rule.from * 10 - Math.round(rule.from * 10)) > 1e-9
        ? "Use a range from 0 to 100 in steps of 0.1."
        : null;
    case "fingerprint":
      return rule.hashes.length === 0 ? "Enter a fingerprint." : null;
  }
};

/** A new rule of a type, with sensible starting values. */
export const createRule = (type: RemoteConfigRuleType): RemoteConfigRule => {
  switch (type) {
    case "platform":
      return { type, platforms: ["ios"] };
    case "channel":
      return { type, channels: [] };
    case "appVersion":
      return { type, range: "" };
    case "cohort":
      return { type, cohorts: [] };
    case "percent":
      return { type, seed: createSeed(), from: 0, to: 10 };
    case "fingerprint":
      return { type, hashes: [] };
  }
};

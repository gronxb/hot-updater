import fs from "fs";
import path from "path";

import {
  SANDBOX_ACTIVITY,
  SANDBOX_META_DATA,
  sandboxUrlSchemeOf,
} from "@hot-updater/protocol/native-artifact";
import { XMLParser } from "fast-xml-parser";

const MAIN = "android.intent.action.MAIN";
const LAUNCHER = "android.intent.category.LAUNCHER";
const SHORTCUTS = "android.app.shortcuts";
const ANDROID = "android:";

type XmlElement = Record<string, unknown>;

/** An intent filter as a manifest holds it: its elements' attributes. */
export interface ManifestIntentFilter {
  readonly actions: readonly XmlElement[];
  readonly categories: readonly XmlElement[];
  readonly data: readonly XmlElement[];
  /** The filter's own attributes, such as `android:priority`. */
  readonly attributes: XmlElement;
}

/** The app's launcher entry, which a sandbox build moves to its activity. */
export interface SandboxLauncher {
  readonly kind: "activity" | "activity-alias";
  readonly name: string;
  /** An alias's `targetActivity`. */
  readonly targetActivity?: string;
  readonly filter: ManifestIntentFilter;
  /** What the launcher shows, when the entry sets its own. */
  readonly label?: string;
  readonly icon?: string;
  readonly roundIcon?: string;
  /** The resource of the entry's static shortcuts. */
  readonly shortcuts?: string;
}

const asArray = (value: unknown): XmlElement[] =>
  value === undefined || value === null || value === ""
    ? []
    : ((Array.isArray(value) ? value : [value]) as XmlElement[]);

const attribute = (element: XmlElement, name: string): string | undefined => {
  const value = element[`${ANDROID}${name}`];
  return typeof value === "string" ? value : undefined;
};

const filtersOf = (component: XmlElement): ManifestIntentFilter[] =>
  asArray(component["intent-filter"]).map((filter) => ({
    actions: asArray(filter["action"]),
    categories: asArray(filter["category"]),
    data: asArray(filter["data"]),
    attributes: Object.fromEntries(
      Object.entries(filter).filter(([name]) => name.startsWith(ANDROID)),
    ),
  }));

const opensAsLauncher = ({ actions, categories }: ManifestIntentFilter) =>
  actions.some((action) => attribute(action, "name") === MAIN) &&
  categories.some((category) => attribute(category, "name") === LAUNCHER);

/** Task settings a sandbox activity can't share a task with: what, and how to fix it. */
const taskRefusal = (name: string, activity: XmlElement): string | null => {
  const launchMode = attribute(activity, "launchMode");
  if (launchMode === "singleInstance" || launchMode === "singleInstancePerTask") {
    return `Sandbox builds don't support launchMode ${launchMode} on the launcher ${name}.\nUse singleTask or the default launch mode.`;
  }
  if (attribute(activity, "taskAffinity") !== undefined) {
    return `Sandbox builds don't support taskAffinity on the launcher ${name}.\nRemove it from this build variant.`;
  }
  const documents = attribute(activity, "documentLaunchMode");
  if (documents !== undefined && documents !== "none") {
    return `Sandbox builds don't support documentLaunchMode ${documents} on the launcher ${name}.\nRemove it from this build variant.`;
  }
  return null;
};

/**
 * The launcher entry of a variant's merged manifest, which already holds what
 * its flavors, build type and libraries declare. It refuses what a sandbox
 * build can't take over: none or several entries, a filter it can't move whole,
 * and task settings its activity can't share a task with.
 */
export const resolveSandboxLauncher = (mergedManifest: string): SandboxLauncher => {
  const application = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
  }).parse(mergedManifest)?.manifest?.application as XmlElement | undefined;
  const activities = asArray(application?.["activity"]);
  const aliases = asArray(application?.["activity-alias"]);
  const entries = [
    ...activities.map((element) => ({ kind: "activity" as const, element })),
    ...aliases.map((element) => ({ kind: "activity-alias" as const, element })),
  ].flatMap(({ kind, element }) => {
    const filters = filtersOf(element).filter(opensAsLauncher);
    return filters.length === 0 ? [] : [{ kind, element, filters }];
  });
  const names = entries.map(({ element }) => attribute(element, "name") ?? "?");
  if (entries.length === 0) {
    throw new Error(
      "A sandbox build needs a launcher, and this variant's manifest has none.\nAdd a MAIN + LAUNCHER intent filter to an activity.",
    );
  }
  if (entries.length > 1) {
    throw new Error(
      `A sandbox build needs one launcher, and this variant has ${names.length}: ${names.join(", ")}.\nKeep one for this build variant.`,
    );
  }
  const { kind, element, filters } = entries[0]!;
  const name = names[0]!;
  if (filters.length > 1) {
    throw new Error(
      `The launcher ${name} has ${filters.length} MAIN + LAUNCHER filters, and a sandbox build can move one.\nKeep one for this build variant.`,
    );
  }
  if (attribute(element, "enabled") === "false") {
    throw new Error(
      `The launcher ${name} is disabled in the manifest, and a sandbox build can't tell when it would open.\nEnable it for this build variant.`,
    );
  }
  const targetActivity =
    kind === "activity-alias" ? attribute(element, "targetActivity") : undefined;
  const activity =
    kind === "activity"
      ? element
      : activities.find((item) => attribute(item, "name") === targetActivity);
  if (activity === undefined) {
    throw new Error(
      `The launcher ${name} targets ${targetActivity ?? "no activity"}, which this variant's manifest doesn't declare.\nFix its android:targetActivity.`,
    );
  }
  const refusal = taskRefusal(name, activity);
  if (refusal !== null) throw new Error(refusal);
  const shortcuts = asArray(element["meta-data"]).find(
    (item) => attribute(item, "name") === SHORTCUTS,
  );
  const label = attribute(element, "label");
  const icon = attribute(element, "icon");
  const roundIcon = attribute(element, "roundIcon");
  const shortcutsResource = shortcuts && attribute(shortcuts, "resource");
  return {
    kind,
    name,
    ...(targetActivity === undefined ? {} : { targetActivity }),
    filter: filters[0]!,
    ...(label === undefined ? {} : { label }),
    ...(icon === undefined ? {} : { icon }),
    ...(roundIcon === undefined ? {} : { roundIcon }),
    ...(shortcutsResource === undefined ? {} : { shortcuts: shortcutsResource }),
  };
};

const xml = (text: string) =>
  text
    .replace(/&/gu, "&amp;")
    .replace(/"/gu, "&quot;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");

const attributesOf = (element: XmlElement) =>
  Object.entries(element)
    .filter(([, value]) => typeof value === "string")
    .map(([name, value]) => ` ${name}="${xml(value as string)}"`)
    .join("");

/** A launcher filter, element by element: the merger matches a filter by content. */
const filterXml = (
  { actions, categories, data, attributes }: ManifestIntentFilter,
  extra = "",
) =>
  [
    `<intent-filter${attributesOf(attributes)}${extra}>`,
    ...actions.map((item) => `  <action${attributesOf(item)} />`),
    ...categories.map((item) => `  <category${attributesOf(item)} />`),
    ...data.map((item) => `  <data${attributesOf(item)} />`),
    "</intent-filter>",
  ]
    .map((line) => `      ${line}`)
    .join("\n");

const optional = (name: string, value: string | undefined) =>
  value === undefined ? "" : ` android:${name}="${xml(value)}"`;

/**
 * The manifest a sandbox build overlays on the app's. `tools:replace` wins over
 * a channel the app's manifest sets, as an Expo project's does. The launcher's
 * filter, label, icon and static shortcuts move to the sandbox's activity, which
 * also takes the links of `appId`'s URL scheme; the rest of the app's activity
 * stays, so its own links still reach it. `appId` is the scheme's `packageName`,
 * before the `.sandbox` suffix, so a preview link needs no build to derive it.
 */
export const sandboxManifestOverlay = ({
  channel,
  appId,
  launcher,
}: {
  channel: string;
  appId: string;
  launcher: SandboxLauncher;
}) => `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android" xmlns:tools="http://schemas.android.com/tools">
  <application>
    <meta-data android:name="com.hotupdater.CHANNEL" android:value="${xml(channel)}" tools:replace="android:value" />
    <meta-data android:name="${SANDBOX_META_DATA}" android:value="true" />
    <activity android:name="${SANDBOX_ACTIVITY}" android:exported="true" android:launchMode="singleTop" android:theme="@style/HotUpdaterSandboxTheme" android:configChanges="keyboard|keyboardHidden|orientation|screenLayout|screenSize|smallestScreenSize|uiMode"${optional("label", launcher.label)}${optional("icon", launcher.icon)}${optional("roundIcon", launcher.roundIcon)}>
${filterXml(launcher.filter)}
      <intent-filter>
        <action android:name="android.intent.action.VIEW" />
        <category android:name="android.intent.category.DEFAULT" />
        <category android:name="android.intent.category.BROWSABLE" />
        <data android:scheme="${sandboxUrlSchemeOf(appId)}" />
      </intent-filter>
      <meta-data android:name="com.hotupdater.sandbox.HOST_ACTIVITY" android:value="${xml(launcher.name)}" />${
        launcher.shortcuts === undefined
          ? ""
          : `\n      <meta-data android:name="${SHORTCUTS}" android:resource="${xml(launcher.shortcuts)}" />`
      }
    </activity>
    <${launcher.kind} android:name="${xml(launcher.name)}"${optional("targetActivity", launcher.targetActivity)}>
${filterXml(launcher.filter, ' tools:node="remove"')}${
  launcher.shortcuts === undefined
    ? ""
    : `\n      <meta-data android:name="${SHORTCUTS}" tools:node="remove" />`
}
    </${launcher.kind}>
    <provider android:name="com.hotupdater.HotUpdaterSandboxProcess" android:authorities="\${applicationId}.hotupdater.sandbox" android:exported="false" />
  </application>
</manifest>
`;

/** Newest first: the manifest of the task that ran last, under `directory`. */
const manifestsUnder = (directory: string): string[] => {
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory, { recursive: true })
    .map(String)
    .filter((file) => path.basename(file) === "AndroidManifest.xml")
    .map((file) => path.join(directory, file))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
};

/** The Gradle task that merges a variant's manifest. */
export const mergeManifestTask = (variant: string) =>
  `process${variant.charAt(0).toUpperCase()}${variant.slice(1)}MainManifest`;

/**
 * The manifest the merge task of `variant` wrote: AGP 7 and 8 keep it under
 * `build/intermediates/merged_manifest`, in a directory per variant.
 */
export const readMergedManifest = ({
  androidProjectPath,
  appModuleName,
  variant,
}: {
  androidProjectPath: string;
  appModuleName: string;
  variant: string;
}): string => {
  const variantDirectory = `${variant.charAt(0).toLowerCase()}${variant.slice(1)}`;
  const intermediates = path.join(
    androidProjectPath,
    appModuleName,
    "build/intermediates",
  );
  const [manifest] = ["merged_manifest", "merged_manifests"].flatMap((name) =>
    manifestsUnder(path.join(intermediates, name, variantDirectory)),
  );
  if (manifest === undefined) {
    throw new Error(
      `Couldn't find the merged manifest of ${variant} under android/${appModuleName}/build/intermediates.\nBuild the variant once, then try again.`,
    );
  }
  return fs.readFileSync(manifest, "utf-8");
};

import type { ComponentType, ReactElement, ReactNode } from "react";

import {
  type ConsoleFeature,
  type ConsoleFeatures,
  consoleFeatures,
} from "@/lib/console-features";
import { useConsoleFeatures } from "@/lib/console-features-api";

import { apiKeysFeatureUi } from "./api-keys/apiKeysFeatureUi";
import { insightsFeatureUi } from "./insights/insightsFeatureUi";

/** A release, as the Bundles page and the release editor hand it to slots. */
export interface ReleaseSlotInput {
  readonly releaseId: string;
  readonly platform: "ios" | "android";
  readonly channel: string;
}

/**
 * A column a feature adds to the Bundles page's release list. `Cell` renders
 * one release, and gets the page's releases too, so a feature can read them
 * all in one request that every cell shares.
 */
export interface ReleaseColumn {
  readonly Cell: ComponentType<{
    readonly releaseId: string;
    readonly releases: readonly ReleaseSlotInput[];
  }>;
}

/** A navigation item a feature adds below Bundles. */
export interface FeatureNavigation {
  readonly icon: ReactNode;
  /** The pathnames where the item shows as active. */
  readonly paths: readonly string[];
  readonly link: (props: {
    readonly features: ConsoleFeatures;
    readonly onClick: () => void;
  }) => ReactElement;
}

/** What a feature adds to the console's pages while it is on. */
export interface ConsoleFeatureUi {
  readonly navigation?: FeatureNavigation;
  readonly releaseColumn?: ReleaseColumn;
  /** A section of the release editor, above its settings. */
  readonly releaseSection?: ComponentType<{
    readonly release: ReleaseSlotInput;
  }>;
}

/** What each feature adds, keyed like `consoleFeatures`. */
export type ConsoleFeatureUiRegistry = {
  readonly [F in ConsoleFeature]?: ConsoleFeatureUi;
};

const consoleFeatureUi: ConsoleFeatureUiRegistry = {
  ...insightsFeatureUi,
  ...apiKeysFeatureUi,
};

const featureIds = Object.keys(consoleFeatures) as ConsoleFeature[];

/**
 * What the features that are on add, in the registry's order, with each
 * feature's label; nothing until the features load.
 */
export const useFeatureUi = (): readonly (ConsoleFeatureUi & {
  readonly feature: ConsoleFeature;
  readonly label: string;
  readonly features: ConsoleFeatures;
})[] => {
  const features = useConsoleFeatures().data?.features;
  if (features === undefined) return [];
  return featureIds.flatMap((feature) => {
    const ui = consoleFeatureUi[feature];
    return ui !== undefined && features[feature]
      ? [{ ...ui, feature, label: consoleFeatures[feature].label, features }]
      : [];
  });
};

/** The release list's feature columns, with their headers. */
export const useReleaseColumns = () =>
  useFeatureUi().flatMap(({ feature, label, releaseColumn }) =>
    releaseColumn === undefined ? [] : [{ ...releaseColumn, feature, label }],
  );

/** The release editor's feature sections, for one release. */
export function ReleaseSections({
  release,
}: {
  readonly release: ReleaseSlotInput;
}) {
  return useFeatureUi().map(({ feature, releaseSection: Section }) =>
    Section === undefined ? null : <Section key={feature} release={release} />,
  );
}

import { Link } from "@tanstack/react-router";
import { ChartNoAxesCombined } from "lucide-react";

import type { ConsoleFeatureUiRegistry } from "../FeatureSlots";
import {
  BundleInsightsSummary,
  releaseActivityColumn,
} from "./ReleaseActivity";

/** What the Insights features add: their navigation item, and release activity on the Bundles page and in the release editor. */
export const insightsFeatureUi = {
  insights: {
    navigation: {
      icon: <ChartNoAxesCombined />,
      paths: ["/insights", "/insights/distribution", "/installations"],
      // A self-hosted server's admin API serves events, not the overview.
      link: ({ features, onClick }) =>
        features.insightsAnalytics ? (
          <Link to="/insights" onClick={onClick} />
        ) : (
          <Link to="/installations" onClick={onClick} />
        ),
    },
  },
  insightsAnalytics: {
    releaseColumn: releaseActivityColumn,
    releaseSection: ({ release }) => <BundleInsightsSummary input={release} />,
  },
} satisfies ConsoleFeatureUiRegistry;

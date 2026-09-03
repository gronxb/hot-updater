import {
  createInsightsModelOracle,
  type InsightsModelOracle,
} from "@hot-updater/test-utils/insights-oracle";

export interface MockInsightsDatabaseNamespaces {
  readonly insightsDatabaseNamespace: string;
  readonly otherInsightsDatabaseNamespace: string;
}

export const MOCK_INSIGHTS_DATABASE_NAMESPACES = {
  insightsDatabaseNamespace: "00000000-0000-7000-8000-00000000d001",
  otherInsightsDatabaseNamespace: "00000000-0000-7000-8000-00000000d002",
} as const;

/**
 * Internal reference-backed Insights runtime for the Mock database provider.
 *
 * The oracle owns the durable namespace stores. Reopening creates new model and
 * control facades over those same stores, which makes restart behavior testable
 * without exposing maintenance controls through the public database plugin.
 */
export type MockInsightsRuntime = InsightsModelOracle;

export const createMockInsightsRuntime = (
  namespaces: MockInsightsDatabaseNamespaces,
): MockInsightsRuntime => createInsightsModelOracle(namespaces);

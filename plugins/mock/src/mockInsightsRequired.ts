import type { RequiredInsightsModel } from "@hot-updater/plugin-core/internal";
import {
  createRequiredInsightsModelOracle,
  type RequiredInsightsModelOracle,
} from "@hot-updater/test-utils/insights-oracle";

/**
 * Internal reference-backed Insights runtime for the Mock database provider.
 *
 * The oracle owns the durable namespace stores. Reopening creates new model and
 * control facades over those same stores, which makes restart behavior testable
 * without exposing maintenance controls through the public database plugin.
 */
export type MockRequiredInsightsRuntime = RequiredInsightsModelOracle;

export const createMockRequiredInsightsRuntime =
  (): MockRequiredInsightsRuntime => createRequiredInsightsModelOracle();

/** Final five-method model factory, held internal until the atomic API flip. */
export const createMockRequiredInsightsModel = (): RequiredInsightsModel =>
  createMockRequiredInsightsRuntime().model;

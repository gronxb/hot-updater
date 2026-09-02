import { DatabasePluginInputError } from "@hot-updater/plugin-core";
import {
  assertInsightsEventContract,
  InsightsContractError,
  isCanonicalInsightsEventId,
} from "@hot-updater/plugin-core/internal";

export const isMongoInsightsEventId = (value: unknown): value is string =>
  isCanonicalInsightsEventId(value);

export const assertMongoInsightsEventRow = (value: unknown): void => {
  try {
    assertInsightsEventContract(value);
  } catch (error) {
    if (error instanceof InsightsContractError)
      throw new DatabasePluginInputError("invalid-result");
    throw error;
  }
};

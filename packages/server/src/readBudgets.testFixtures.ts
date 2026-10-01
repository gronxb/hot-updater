import { toolingTargetOf } from "@hot-updater/plugin-core";
import type { ReadBudgetServer } from "@hot-updater/test-utils";

import { createMeasuredDatabase } from "./assembly/databasePlugins";
import { targetBaseCandidateKey } from "./core/baseCandidates";
import { apiKeys } from "./plugins/api-keys";
import { insights } from "./plugins/insights";

/** The server parts `setupReadBudgetTestSuite` takes, for the server's own backends. */
export const readBudgetServer = {
  createMeasuredDatabase,
  toolingTargetOf,
  plugins: [insights(), apiKeys()],
  targetBaseCandidateKey,
} satisfies ReadBudgetServer;

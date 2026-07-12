import { createScriptedDatabaseConnectorV2Harness } from "./database-v2/spec-support/scriptedHarness";
import { setupDatabaseConnectorV2TestSuite } from "./setupDatabaseConnectorV2TestSuite";

setupDatabaseConnectorV2TestSuite(createScriptedDatabaseConnectorV2Harness());

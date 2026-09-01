import { registerRequiredInsightsModelTests } from "./requiredInsightsModelConformance";
import { createRequiredInsightsModelOracle } from "./requiredInsightsModelOracle";

registerRequiredInsightsModelTests(createRequiredInsightsModelOracle);

import React from "react";

import { ValueText } from "../components";
import { useE2eRuntimeModelContext } from "../runtime-model-context";

export const RuntimeInitialCohortScreen = () => {
  const model = useE2eRuntimeModelContext();

  return (
    <ValueText testID="runtime-initial-cohort" value={model.initialCohort} />
  );
};

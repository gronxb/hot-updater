import React from "react";

import { Stack } from "../route-stack";
import { CohortInputScreen } from "../screens/cohort-input-screen";

export const cohortInputRoute = (
  <Stack.Screen name="CohortInput" component={CohortInputScreen} />
);

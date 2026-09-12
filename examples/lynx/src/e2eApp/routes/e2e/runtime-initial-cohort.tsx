import { createFileRoute } from "@tanstack/react-router";

import { RuntimeInitialCohortScreen } from "../../screens";

export const Route = createFileRoute("/e2e/runtime-initial-cohort")({
  component: RuntimeInitialCohortScreen,
});

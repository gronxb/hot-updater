import { createFileRoute } from "@tanstack/react-router";

import { RuntimeCurrentCohortScreen } from "../../screens";

export const Route = createFileRoute("/e2e/runtime-current-cohort")({
  component: RuntimeCurrentCohortScreen,
});

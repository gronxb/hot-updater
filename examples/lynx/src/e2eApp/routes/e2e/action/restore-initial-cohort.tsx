import { createFileRoute } from "@tanstack/react-router";

import { RestoreInitialCohortActionScreen } from "../../../screens";

export const Route = createFileRoute("/e2e/action/restore-initial-cohort")({
  component: RestoreInitialCohortActionScreen,
});

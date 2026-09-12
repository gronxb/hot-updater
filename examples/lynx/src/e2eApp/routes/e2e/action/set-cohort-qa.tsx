import { createFileRoute } from "@tanstack/react-router";

import { SetCohortQaActionScreen } from "../../../screens";

export const Route = createFileRoute("/e2e/action/set-cohort-qa")({
  component: SetCohortQaActionScreen,
});

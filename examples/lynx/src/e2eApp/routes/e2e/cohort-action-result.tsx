import { createFileRoute } from "@tanstack/react-router";

import { CohortActionResultScreen } from "../../screens";

export const Route = createFileRoute("/e2e/cohort-action-result")({
  component: CohortActionResultScreen,
});

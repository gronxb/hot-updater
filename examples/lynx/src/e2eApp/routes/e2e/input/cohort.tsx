import { createFileRoute } from "@tanstack/react-router";

import { CohortInputScreen } from "../../../screens";

export const Route = createFileRoute("/e2e/input/cohort")({
  component: CohortInputScreen,
});

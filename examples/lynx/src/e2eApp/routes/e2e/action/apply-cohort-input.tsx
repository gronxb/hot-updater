import { createFileRoute } from "@tanstack/react-router";

import { ApplyCohortInputActionScreen } from "../../../screens";

export const Route = createFileRoute("/e2e/action/apply-cohort-input")({
  component: ApplyCohortInputActionScreen,
});

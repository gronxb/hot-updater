import { createFileRoute } from "@tanstack/react-router";

import { ApplyCapturedUpdateActionScreen } from "../../../screens";

export const Route = createFileRoute("/e2e/action/apply-captured-update")({
  component: ApplyCapturedUpdateActionScreen,
});

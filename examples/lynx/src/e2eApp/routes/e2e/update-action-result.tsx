import { createFileRoute } from "@tanstack/react-router";

import { UpdateActionResultScreen } from "../../screens";

export const Route = createFileRoute("/e2e/update-action-result")({
  component: UpdateActionResultScreen,
});

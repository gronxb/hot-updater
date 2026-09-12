import { createFileRoute } from "@tanstack/react-router";

import { LaunchStatusScreen } from "../../screens";

export const Route = createFileRoute("/e2e/launch-status")({
  component: LaunchStatusScreen,
});

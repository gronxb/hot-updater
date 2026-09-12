import { createFileRoute } from "@tanstack/react-router";

import { InstallRuntimeChannelUpdateActionScreen } from "../../../screens";

export const Route = createFileRoute(
  "/e2e/action/install-runtime-channel-update",
)({
  component: InstallRuntimeChannelUpdateActionScreen,
});

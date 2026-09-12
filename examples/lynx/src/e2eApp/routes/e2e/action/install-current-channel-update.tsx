import { createFileRoute } from "@tanstack/react-router";

import { InstallCurrentChannelUpdateActionScreen } from "../../../screens";

export const Route = createFileRoute(
  "/e2e/action/install-current-channel-update",
)({
  component: InstallCurrentChannelUpdateActionScreen,
});

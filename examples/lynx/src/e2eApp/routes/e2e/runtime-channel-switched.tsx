import { createFileRoute } from "@tanstack/react-router";

import { RuntimeChannelSwitchedScreen } from "../../screens";

export const Route = createFileRoute("/e2e/runtime-channel-switched")({
  component: RuntimeChannelSwitchedScreen,
});

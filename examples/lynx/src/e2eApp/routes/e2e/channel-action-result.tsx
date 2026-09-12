import { createFileRoute } from "@tanstack/react-router";

import { ChannelActionResultScreen } from "../../screens";

export const Route = createFileRoute("/e2e/channel-action-result")({
  component: ChannelActionResultScreen,
});

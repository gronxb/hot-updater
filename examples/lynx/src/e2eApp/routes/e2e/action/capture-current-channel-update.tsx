import { createFileRoute } from "@tanstack/react-router";

import { CaptureCurrentChannelUpdateActionScreen } from "../../../screens";

export const Route = createFileRoute(
  "/e2e/action/capture-current-channel-update",
)({
  component: CaptureCurrentChannelUpdateActionScreen,
});

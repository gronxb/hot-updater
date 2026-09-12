import { createFileRoute } from "@tanstack/react-router";

import { RuntimeCurrentChannelScreen } from "../../screens";

export const Route = createFileRoute("/e2e/runtime-current-channel")({
  component: RuntimeCurrentChannelScreen,
});

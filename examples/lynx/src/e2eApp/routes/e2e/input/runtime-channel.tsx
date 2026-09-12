import { createFileRoute } from "@tanstack/react-router";

import { RuntimeChannelInputScreen } from "../../../screens";

export const Route = createFileRoute("/e2e/input/runtime-channel")({
  component: RuntimeChannelInputScreen,
});

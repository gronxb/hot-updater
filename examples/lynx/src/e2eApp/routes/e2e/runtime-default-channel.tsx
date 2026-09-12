import { createFileRoute } from "@tanstack/react-router";

import { RuntimeDefaultChannelScreen } from "../../screens";

export const Route = createFileRoute("/e2e/runtime-default-channel")({
  component: RuntimeDefaultChannelScreen,
});

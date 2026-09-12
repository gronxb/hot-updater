import { createFileRoute } from "@tanstack/react-router";

import { ResetRuntimeChannelActionScreen } from "../../../screens";

export const Route = createFileRoute("/e2e/action/reset-runtime-channel")({
  component: ResetRuntimeChannelActionScreen,
});

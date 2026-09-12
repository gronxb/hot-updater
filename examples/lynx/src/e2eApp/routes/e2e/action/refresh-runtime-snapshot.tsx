import { createFileRoute } from "@tanstack/react-router";

import { RefreshRuntimeSnapshotActionScreen } from "../../../screens";

export const Route = createFileRoute("/e2e/action/refresh-runtime-snapshot")({
  component: RefreshRuntimeSnapshotActionScreen,
});

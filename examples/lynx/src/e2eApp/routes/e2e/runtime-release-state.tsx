import { createFileRoute } from "@tanstack/react-router";

import { RuntimeReleaseStateScreen } from "../../screens";

export const Route = createFileRoute("/e2e/runtime-release-state")({
  component: RuntimeReleaseStateScreen,
});

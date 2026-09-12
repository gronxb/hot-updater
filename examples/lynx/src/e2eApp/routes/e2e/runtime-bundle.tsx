import { createFileRoute } from "@tanstack/react-router";

import { RuntimeBundleScreen } from "../../screens";

export const Route = createFileRoute("/e2e/runtime-bundle")({
  component: RuntimeBundleScreen,
});

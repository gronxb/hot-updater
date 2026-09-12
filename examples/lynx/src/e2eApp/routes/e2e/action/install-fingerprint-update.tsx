import { createFileRoute } from "@tanstack/react-router";

import { InstallFingerprintUpdateActionScreen } from "../../../screens";

export const Route = createFileRoute("/e2e/action/install-fingerprint-update")({
  component: InstallFingerprintUpdateActionScreen,
});

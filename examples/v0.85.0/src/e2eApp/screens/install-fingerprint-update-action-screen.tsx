import React from "react";

import { FocusedActionRoute } from "../components";
import { useE2eRuntimeModelContext } from "../runtime-model-context";

export const InstallFingerprintUpdateActionScreen = () => {
  const model = useE2eRuntimeModelContext();

  return (
    <FocusedActionRoute
      onFocus={() =>
        model.installUpdate({
          actionLabel: "fingerprint",
          strategy: "fingerprint",
        })
      }
      testID="action-install-fingerprint-update"
      title="Install Fingerprint"
    />
  );
};

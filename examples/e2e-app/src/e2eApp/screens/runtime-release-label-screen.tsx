import { useFocusEffect } from "@react-navigation/native";
import React, { useCallback, useState } from "react";

import { ValueText } from "../components";
import { useE2eRuntimeModelContext } from "../runtime-model-context";

export const RuntimeReleaseLabelScreen = () => {
  const model = useE2eRuntimeModelContext();
  const [isReady, setIsReady] = useState(false);
  useFocusEffect(
    useCallback(() => {
      let isActive = true;
      setIsReady(false);
      void model.refreshRuntimeSnapshot().then(() => {
        if (isActive) setIsReady(true);
      });
      return () => {
        isActive = false;
      };
    }, [model.refreshRuntimeSnapshot]),
  );
  if (!isReady) return null;
  return (
    <ValueText
      testID="runtime-release-label"
      value={model.runtimeSnapshot.reportedReleaseLabel}
    />
  );
};

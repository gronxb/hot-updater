import { useFocusEffect } from "@react-navigation/native";
import React, { useCallback, useState } from "react";

import { ValueText } from "../components";
import { useE2eRuntimeModelContext } from "../runtime-model-context";

export const RuntimeReleaseStateScreen = () => {
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
  const snapshot = model.runtimeSnapshot;
  if (!isReady) return null;
  return (
    <ValueText
      testID="runtime-release-state"
      value={JSON.stringify({
        activeReleaseId: snapshot.activeReleaseId,
        catalogId: snapshot.catalogId,
        channel: snapshot.channel,
        generation: snapshot.generation,
        highWater: JSON.parse(snapshot.highWater),
        scopeKey: snapshot.scopeKey,
        selectionContextHash: snapshot.selectionContextHash,
        selectionKind: snapshot.selectionKind,
      })}
    />
  );
};

import { useFocusEffect } from "@react-navigation/native";
import React, { useCallback, useRef } from "react";

import { ValueText } from "../components";
import { useE2eRuntimeModelContext } from "../runtime-model-context";

export const RuntimeReleaseStateScreen = () => {
  const model = useE2eRuntimeModelContext();
  const didRefresh = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (!didRefresh.current) {
        didRefresh.current = true;
        void model.refreshRuntimeSnapshot();
      }
    }, [model.refreshRuntimeSnapshot]),
  );
  const snapshot = model.runtimeSnapshot;
  return (
    <ValueText
      testID="runtime-release-state"
      value={JSON.stringify({
        activeReleaseId: snapshot.activeReleaseId,
        authorityId: snapshot.authorityId,
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

import { HotUpdater } from "@hot-updater/react-native";
import React from "react";
import { View } from "react-native";

import { ValueText } from "./components";
import { maybeThrowDuringRenderForE2E } from "./patchSurface";

type RenderErrorBoundaryState = { readonly failed: boolean };

const RenderErrorProbe = (): null => {
  maybeThrowDuringRenderForE2E();
  return null;
};

export class E2eRenderErrorBoundary extends React.Component<
  { readonly children: React.ReactNode },
  RenderErrorBoundaryState
> {
  state: RenderErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): RenderErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch() {
    // Runs before the app shell's effect calls HotUpdater.init(), so the
    // bundle is still on trial and notifyAppReady() will not promote it.
    if (HotUpdater.reportBundleFailure()) {
      void HotUpdater.reload();
    }
  }

  render() {
    if (this.state.failed) {
      return (
        <View style={{ flex: 1, justifyContent: "center", padding: 24 }}>
          <ValueText
            testID="render-error-fallback"
            value="render error caught"
          />
        </View>
      );
    }

    return (
      <>
        <RenderErrorProbe />
        {this.props.children}
      </>
    );
  }
}

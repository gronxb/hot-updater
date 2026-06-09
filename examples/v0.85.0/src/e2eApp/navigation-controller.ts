import {
  CommonActions,
  createNavigationContainerRef,
} from "@react-navigation/native";
import { useEffect } from "react";
import { Linking } from "react-native";

import { screenNameFromE2eUrl } from "./route-paths";
import type { RootStackParamList, ScreenName } from "./types";

export const navigationRef = createNavigationContainerRef<RootStackParamList>();

let pendingScreen: ScreenName | undefined;

export const navigateE2eScreen = (screen: ScreenName): void => {
  if (!navigationRef.isReady()) {
    pendingScreen = screen;
    return;
  }

  navigationRef.dispatch(CommonActions.navigate(screen));
};

export const handleE2eDeepLink = (url: string | null | undefined): void => {
  if (!url) return;

  const screen = screenNameFromE2eUrl(url);
  if (!screen) return;

  navigateE2eScreen(screen);
};

export const flushPendingE2eDeepLink = (): void => {
  if (!pendingScreen) return;

  const screen = pendingScreen;
  pendingScreen = undefined;
  navigateE2eScreen(screen);
};

export const useE2eDeepLinks = (): void => {
  useEffect(() => {
    let mounted = true;

    void Linking.getInitialURL().then((url) => {
      if (mounted) handleE2eDeepLink(url);
    });

    const subscription = Linking.addEventListener("url", ({ url }) => {
      handleE2eDeepLink(url);
    });

    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);
};

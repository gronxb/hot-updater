import { Link } from "@tanstack/react-router";
import { SlidersHorizontal } from "lucide-react";

import type { ConsoleFeatureUiRegistry } from "../FeatureSlots";

/** What Remote Config adds: its navigation item. */
export const remoteConfigFeatureUi = {
  remoteConfig: {
    navigation: {
      icon: <SlidersHorizontal />,
      paths: ["/remote-config"],
      link: ({ onClick }) => <Link to="/remote-config" onClick={onClick} />,
    },
  },
} satisfies ConsoleFeatureUiRegistry;

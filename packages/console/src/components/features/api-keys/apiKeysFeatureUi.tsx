import { Link } from "@tanstack/react-router";
import { KeyRound } from "lucide-react";

import type { ConsoleFeatureUiRegistry } from "../FeatureSlots";

/** What API key management adds: its navigation item. */
export const apiKeysFeatureUi = {
  apiKeys: {
    navigation: {
      icon: <KeyRound />,
      paths: ["/api-keys"],
      link: ({ onClick }) => <Link to="/api-keys" onClick={onClick} />,
    },
  },
} satisfies ConsoleFeatureUiRegistry;

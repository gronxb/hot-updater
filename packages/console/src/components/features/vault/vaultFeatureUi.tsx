import { Link } from "@tanstack/react-router";
import { LockKeyhole } from "lucide-react";

import type { ConsoleFeatureUiRegistry } from "../FeatureSlots";

/** What the vault adds: its navigation item. */
export const vaultFeatureUi = {
  vault: {
    navigation: {
      icon: <LockKeyhole />,
      paths: ["/vault"],
      link: ({ onClick }) => <Link to="/vault" onClick={onClick} />,
    },
  },
} satisfies ConsoleFeatureUiRegistry;

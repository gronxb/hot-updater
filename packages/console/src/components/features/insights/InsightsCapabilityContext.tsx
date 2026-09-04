import { createContext, useContext, type ReactNode } from "react";

import type { InsightsCapabilityState } from "@/lib/insights-api";

const InsightsCapabilityContext = createContext<InsightsCapabilityState>({
  status: "unresolved",
});

export function InsightsCapabilityProvider({
  children,
  value,
}: {
  readonly children: ReactNode;
  readonly value: InsightsCapabilityState;
}) {
  return (
    <InsightsCapabilityContext.Provider value={value}>
      {children}
    </InsightsCapabilityContext.Provider>
  );
}

export const useInsightsCapability = (): InsightsCapabilityState =>
  useContext(InsightsCapabilityContext);

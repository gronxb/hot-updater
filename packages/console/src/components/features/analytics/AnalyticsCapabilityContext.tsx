import { createContext, useContext, type ReactNode } from "react";

import type { AnalyticsCapabilityState } from "@/lib/analytics-api";

const AnalyticsCapabilityContext = createContext<AnalyticsCapabilityState>({
  status: "unresolved",
});

export function AnalyticsCapabilityProvider({
  children,
  value,
}: {
  readonly children: ReactNode;
  readonly value: AnalyticsCapabilityState;
}) {
  return (
    <AnalyticsCapabilityContext.Provider value={value}>
      {children}
    </AnalyticsCapabilityContext.Provider>
  );
}

export const useAnalyticsCapability = (): AnalyticsCapabilityState =>
  useContext(AnalyticsCapabilityContext);

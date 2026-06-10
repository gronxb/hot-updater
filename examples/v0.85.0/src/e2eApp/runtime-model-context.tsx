import React, { createContext, type ReactNode, useContext } from "react";

import type { E2eRuntimeModel } from "./runtime-model";

const E2eRuntimeModelContext = createContext<E2eRuntimeModel | null>(null);

export const E2eRuntimeModelProvider = ({
  children,
  model,
}: {
  readonly children: ReactNode;
  readonly model: E2eRuntimeModel;
}) => (
  <E2eRuntimeModelContext.Provider value={model}>
    {children}
  </E2eRuntimeModelContext.Provider>
);

export const useE2eRuntimeModelContext = (): E2eRuntimeModel => {
  const model = useContext(E2eRuntimeModelContext);
  if (!model) {
    throw new Error("E2E runtime model context is not mounted");
  }
  return model;
};

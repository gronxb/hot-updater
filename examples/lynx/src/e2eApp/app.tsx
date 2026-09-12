import { RouterProvider } from "@tanstack/react-router";

import { router } from "./router";
import { E2eRuntimeProvider } from "./runtime-model";

export function App() {
  return (
    <E2eRuntimeProvider>
      <RouterProvider router={router} />
    </E2eRuntimeProvider>
  );
}

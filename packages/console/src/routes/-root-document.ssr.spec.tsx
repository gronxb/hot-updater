// @vitest-environment node

import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-devtools", () => {
  throw new Error("Client-only React Devtools were loaded during SSR");
});
vi.mock("@tanstack/react-router-devtools", () => {
  throw new Error("Client-only Router Devtools were loaded during SSR");
});
vi.mock("@tanstack/react-router", () => ({
  createRootRouteWithContext: () => (options: unknown) => ({ options }),
  HeadContent: () => null,
  Outlet: () => null,
  Scripts: () => null,
}));
vi.mock("@/components/ThemeProvider", () => ({
  ThemeProvider: ({ children }: { readonly children: React.ReactNode }) =>
    children,
}));
vi.mock("@/components/ui/sonner", () => ({ Toaster: () => null }));
vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { readonly children: React.ReactNode }) =>
    children,
}));

import { RootDocument } from "./__root";

describe("RootDocument SSR", () => {
  it("does not load client-only devtools", () => {
    expect(() =>
      renderToString(<RootDocument>Content</RootDocument>),
    ).not.toThrow();
  });
});

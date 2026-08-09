import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-grab", () => ({}));

vi.mock("@tanstack/react-router", () => ({
  createRootRouteWithContext: () => (options: unknown) => ({ options }),
  HeadContent: () => null,
  Outlet: () => <div>Current route</div>,
  Scripts: () => null,
}));

vi.mock("@/components/AppSidebar", () => ({
  AppSidebar: () => null,
}));
vi.mock("@/components/features/analytics/AnalyticsCapabilityContext", () => ({
  AnalyticsCapabilityProvider: ({
    children,
  }: {
    readonly children: React.ReactNode;
  }) => children,
}));
vi.mock("@/components/ui/sidebar", () => ({
  SidebarInset: ({
    children,
    className,
  }: {
    readonly children: React.ReactNode;
    readonly className?: string;
  }) => <main className={className}>{children}</main>,
  SidebarProvider: ({ children }: { readonly children: React.ReactNode }) =>
    children,
}));
vi.mock("@/lib/analytics-api", () => ({
  getAnalyticsCapabilityState: () => ({ status: "unsupported" }),
  useAnalyticsCapabilitiesQuery: () => ({ status: "success" }),
}));

import { Route } from "./__root";

const RootLayout = Route.options.component;
if (!RootLayout) throw new Error("Root layout component is required");

describe("RootLayout", () => {
  afterEach(cleanup);

  it("contains route overflow inside the sidebar inset", () => {
    // Given / When
    render(<RootLayout />);

    // Then
    expect(screen.getByRole("main").className).toContain("overflow-hidden");
  });
});

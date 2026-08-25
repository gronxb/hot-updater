import { cleanup, render, screen } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => options,
}));

vi.mock("@/components/features/signing/BundleSigningPage", () => ({
  BundleSigningPage: () => <div>Signing inspection content</div>,
}));

vi.mock("@/components/ui/sidebar", () => ({
  SidebarTrigger: () => null,
}));

import { Route } from "./signing";

const SigningRoute = (Route as unknown as { readonly component: ComponentType })
  .component;

describe("BundleSigningRoute", () => {
  afterEach(cleanup);

  it("labels the signing inspection as read-only", () => {
    render(<SigningRoute />);

    expect(
      screen.getByRole("heading", { name: "Bundle signing" }),
    ).toBeDefined();
    expect(screen.getByText("Read-only")).toBeDefined();
    expect(screen.getByText("Signing inspection content")).toBeDefined();
  });
});

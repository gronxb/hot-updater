import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AnalyticsCapabilityState } from "@/lib/analytics-api";

import { AnalyticsRouteGate } from "./AnalyticsRouteGate";

let analyticsCapability: AnalyticsCapabilityState = { status: "unresolved" };

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="/">{children}</a>,
}));

vi.mock("./AnalyticsCapabilityContext", () => ({
  useAnalyticsCapability: () => analyticsCapability,
}));

const supported = { status: "supported", mode: "dedicated" } as const;

describe("AnalyticsRouteGate", () => {
  afterEach(() => {
    cleanup();
    analyticsCapability = { status: "unresolved" };
  });

  it("never blocks the Bundles route", () => {
    render(
      <AnalyticsRouteGate pathname="/" onRedirect={vi.fn()}>
        <div>Bundles content</div>
      </AnalyticsRouteGate>,
    );

    expect(screen.getByText("Bundles content")).toBeDefined();
  });

  it.each(["/analytics", "/installations"])(
    "withholds protected content while %s capability is unresolved",
    (pathname) => {
      analyticsCapability = { status: "unresolved" };
      const protectedMount = vi.fn();
      const ProtectedContent = () => {
        protectedMount();
        return <div>Protected content</div>;
      };

      render(
        <AnalyticsRouteGate pathname={pathname} onRedirect={vi.fn()}>
          <ProtectedContent />
        </AnalyticsRouteGate>,
      );

      expect(screen.getByRole("status")).toBeDefined();
      expect(screen.queryByText("Protected content")).toBeNull();
      expect(protectedMount).not.toHaveBeenCalled();
    },
  );

  it("renders protected content only when capability is supported", () => {
    analyticsCapability = supported;
    render(
      <AnalyticsRouteGate pathname="/analytics" onRedirect={vi.fn()}>
        <div>Protected content</div>
      </AnalyticsRouteGate>,
    );

    expect(screen.getByText("Protected content")).toBeDefined();
  });

  it("redirects unsupported routes without mounting protected content", async () => {
    analyticsCapability = { status: "unsupported" };
    const onRedirect = vi.fn();
    const protectedMount = vi.fn();
    const ProtectedContent = () => {
      protectedMount();
      return <div>Protected content</div>;
    };

    render(
      <AnalyticsRouteGate pathname="/analytics" onRedirect={onRedirect}>
        <ProtectedContent />
      </AnalyticsRouteGate>,
    );

    await waitFor(() => expect(onRedirect).toHaveBeenCalledOnce());
    expect(protectedMount).not.toHaveBeenCalled();
    expect(screen.queryByText("Protected content")).toBeNull();
  });

  it("shows a diagnosable capability error without protected content", () => {
    analyticsCapability = {
      status: "error",
      error: new Error("Network offline"),
    };
    const protectedMount = vi.fn();
    const ProtectedContent = () => {
      protectedMount();
      return <div>Protected content</div>;
    };

    const { container } = render(
      <AnalyticsRouteGate pathname="/installations" onRedirect={vi.fn()}>
        <ProtectedContent />
      </AnalyticsRouteGate>,
    );

    expect(screen.getByRole("alert").textContent).toContain("Network offline");
    expect(
      screen.getByRole("link", { name: /back to bundles/i }),
    ).toBeDefined();
    expect(container.querySelector("main")).toBeNull();
    expect(protectedMount).not.toHaveBeenCalled();
  });
});

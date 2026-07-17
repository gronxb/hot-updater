import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AnalyticsRouteGate } from "./AnalyticsRouteGate";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="/">{children}</a>,
}));

const supported = { status: "supported" } as const;

describe("AnalyticsRouteGate", () => {
  afterEach(cleanup);

  it("never blocks the Bundles route", () => {
    render(
      <AnalyticsRouteGate
        pathname="/"
        capability={{ status: "unresolved" }}
        onRedirect={vi.fn()}
      >
        <div>Bundles content</div>
      </AnalyticsRouteGate>,
    );

    expect(screen.getByText("Bundles content")).toBeDefined();
  });

  it.each(["/analytics", "/installations"])(
    "withholds protected content while %s capability is unresolved",
    (pathname) => {
      const protectedMount = vi.fn();
      const ProtectedContent = () => {
        protectedMount();
        return <div>Protected content</div>;
      };

      render(
        <AnalyticsRouteGate
          pathname={pathname}
          capability={{ status: "unresolved" }}
          onRedirect={vi.fn()}
        >
          <ProtectedContent />
        </AnalyticsRouteGate>,
      );

      expect(screen.getByRole("status")).toBeDefined();
      expect(screen.queryByText("Protected content")).toBeNull();
      expect(protectedMount).not.toHaveBeenCalled();
    },
  );

  it("renders protected content only when capability is supported", () => {
    render(
      <AnalyticsRouteGate
        pathname="/analytics"
        capability={supported}
        onRedirect={vi.fn()}
      >
        <div>Protected content</div>
      </AnalyticsRouteGate>,
    );

    expect(screen.getByText("Protected content")).toBeDefined();
  });

  it("redirects unsupported routes without mounting protected content", async () => {
    const onRedirect = vi.fn();
    const protectedMount = vi.fn();
    const ProtectedContent = () => {
      protectedMount();
      return <div>Protected content</div>;
    };

    render(
      <AnalyticsRouteGate
        pathname="/analytics"
        capability={{ status: "unsupported" }}
        onRedirect={onRedirect}
      >
        <ProtectedContent />
      </AnalyticsRouteGate>,
    );

    await waitFor(() => expect(onRedirect).toHaveBeenCalledOnce());
    expect(protectedMount).not.toHaveBeenCalled();
    expect(screen.queryByText("Protected content")).toBeNull();
  });

  it("shows a diagnosable capability error without protected content", () => {
    const protectedMount = vi.fn();
    const ProtectedContent = () => {
      protectedMount();
      return <div>Protected content</div>;
    };

    const { container } = render(
      <AnalyticsRouteGate
        pathname="/installations"
        capability={{ status: "error", error: new Error("Network offline") }}
        onRedirect={vi.fn()}
      >
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

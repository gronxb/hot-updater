import { cleanup, render } from "@testing-library/react";
import { cloneElement, type ReactElement } from "react";
import { afterEach, expect, it, vi } from "vitest";

import type { RecoverySeries } from "@/lib/insights-recovery";

import { BundleActivityChart } from "./BundleActivityChart";

vi.mock("recharts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("recharts")>()),
  ResponsiveContainer: ({ children }: { children: ReactElement }) =>
    cloneElement(children, { width: 400, height: 160 } as object),
}));

afterEach(cleanup);

it("shows a single observed active value without inventing observations in earlier intervals", () => {
  const series: RecoverySeries = {
    releaseId: "bundle-a",
    firstAppliedAtMs: 2 * 3_600_000,
    activeInstallations: 2,
    pendingInstallations: 0,
    downloadedInstallations: 0,
    recoveredInstallations: 0,
    points: [null, null, 2].map((active, index) => ({
      startMs: index * 3_600_000,
      active,
      pendingInstallations: 0,
      downloadedInstallations: 0,
      recoveredInstallations: 0,
      applied: active ?? 0,
      recovered: 0,
      rate: active === null ? null : 0,
      spike: false,
    })),
  };
  const { container } = render(<BundleActivityChart series={series} />);
  const dots = container.querySelectorAll(".recharts-area-dot");
  expect(dots).toHaveLength(1);
  expect(dots[0].getAttribute("r")).toBe("2");
  expect(Number(dots[0].getAttribute("cx"))).toBeGreaterThan(300);
  expect(Number(dots[0].getAttribute("cy"))).toBeGreaterThan(0);
});

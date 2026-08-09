import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChartContainer, ChartTooltipContent } from "./chart";

vi.mock("recharts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("recharts")>();

  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
      <>{children}</>
    ),
  };
});

describe("ChartTooltipContent", () => {
  afterEach(cleanup);

  it("keeps the series label and value visibly separated", () => {
    render(
      <ChartContainer
        config={{
          value: {
            color: "var(--chart-2)",
            label: "Active installations",
          },
        }}
      >
        <ChartTooltipContent
          active
          label="Jul 14"
          payload={[
            {
              color: "var(--chart-2)",
              dataKey: "value",
              graphicalItemId: "value",
              name: "value",
              payload: { value: 2 },
              value: 2,
            },
          ]}
        />
      </ChartContainer>,
    );

    const label = screen.getByText("Active installations");
    const value = screen.getByText("2");
    const content = label.parentElement?.parentElement;

    expect(value.parentElement).toBe(content);
    expect(content?.className).toContain("gap-2");
  });
});

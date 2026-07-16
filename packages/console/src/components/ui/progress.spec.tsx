import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Progress } from "./progress";

describe("Progress", () => {
  afterEach(cleanup);

  it("transitions only the indicator transform while respecting reduced motion", () => {
    const { container } = render(<Progress value={50} />);

    const indicator = container.querySelector(
      '[data-slot="progress-indicator"]',
    );

    expect(indicator?.classList.contains("transition-transform")).toBe(true);
    expect(indicator?.classList.contains("motion-reduce:transition-none")).toBe(
      true,
    );
    expect(indicator?.classList.contains("transition-all")).toBe(false);
  });
});

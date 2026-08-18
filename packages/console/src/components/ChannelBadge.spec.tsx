import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ChannelBadge } from "./ChannelBadge";

describe("ChannelBadge", () => {
  afterEach(cleanup);

  it("keeps custom channel names neutral like the main Console", () => {
    render(
      <ChannelBadge channel="e2e-job-20260812132427-android-production" />,
    );

    const badge = screen.getByText("e2e-job-20260812132427-android-production");
    expect(badge.className).toContain("bg-gray-500/10");
    expect(badge.className).toContain("text-gray-700");
  });
});

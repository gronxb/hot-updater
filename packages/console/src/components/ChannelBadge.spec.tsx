import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ChannelBadge } from "./ChannelBadge";

/** Tailwind's raw palette, which the theme's tokens replace. */
const RAW_PALETTE = /\b(?:bg|text|border)-(?:gray|green|yellow|blue)-\d/;

describe("ChannelBadge", () => {
  afterEach(cleanup);

  it("keeps custom channel names neutral like the main Console", () => {
    render(
      <ChannelBadge channel="e2e-job-20260812132427-android-production" />,
    );

    const badge = screen.getByText("e2e-job-20260812132427-android-production");
    expect(badge.dataset["channel"]).toBeUndefined();
    expect(badge.className).toContain("bg-channel-other/10");
    expect(badge.className).toContain("text-channel-other");
    expect(badge.className).not.toMatch(RAW_PALETTE);
  });

  it.each([
    ["production", "channel-production"],
    ["staging", "channel-staging"],
    ["dev", "channel-dev"],
    ["Production", "channel-production"],
  ])("colors %s with the theme's %s token", (channel, token) => {
    render(<ChannelBadge channel={channel} />);

    const badge = screen.getByText(channel);
    const name = token.replace("channel-", "");
    expect(badge.dataset["channel"]).toBe(name);
    const when = `data-[channel=${name}]:`;
    expect(badge.className).toContain(`${when}bg-${token}/10`);
    expect(badge.className).toContain(`${when}border-${token}/20`);
    expect(badge.className).toContain(`${when}text-${token}`);
    expect(badge.className).not.toMatch(RAW_PALETTE);
  });
});

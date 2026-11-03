import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BuildKeyDisplay, TargetDisplay } from "./TargetDisplay";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const FINGERPRINT = "e7b2a84d0123456789abcdef0123456789ab9efb";
const BUILD_KEY = `nbk1:a1b2c3d4${"0".repeat(52)}9f0e`;

describe("TargetDisplay", () => {
  it("shortens a fingerprint to xxxxxxxx…xxxx and copies the whole value", () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.assign(navigator, { clipboard: { writeText } });
    render(<TargetDisplay appVersion={null} fingerprintHash={FINGERPRINT} />);

    const pill = screen.getByRole("button", {
      name: `Copy full value: ${FINGERPRINT}`,
    });
    expect(pill.textContent).toBe("e7b2a84d…9efb");
    fireEvent.click(pill);
    expect(writeText).toHaveBeenCalledWith(FINGERPRINT);
  });

  it("shows an app version as it is, before any fingerprint", () => {
    const { container } = render(
      <TargetDisplay appVersion="1.4.2" fingerprintHash={FINGERPRINT} />,
    );
    expect(container.textContent).toBe("1.4.2");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows - when there is no target", () => {
    const { container } = render(
      <TargetDisplay appVersion={null} fingerprintHash={null} />,
    );
    expect(container.textContent).toBe("-");
  });
});

describe("BuildKeyDisplay", () => {
  it("keeps 8 characters past the nbk1: prefix, and copies the whole key", () => {
    render(<BuildKeyDisplay value={BUILD_KEY} />);
    expect(
      screen.getByRole("button", { name: `Copy full value: ${BUILD_KEY}` })
        .textContent,
    ).toBe("nbk1:a1b2c3d4…9f0e");
  });

  it("shows - for an imported build, which has no key", () => {
    const { container } = render(<BuildKeyDisplay value={null} />);
    expect(container.textContent).toBe("-");
  });
});

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ArtifactIdDisplay } from "./ArtifactIdDisplay";

const id = "01a13d86-86f7-7830-952d-21238207019f";

afterEach(cleanup);

describe("ArtifactIdDisplay", () => {
  it("shows an artifact's full ID as text a click selects whole", () => {
    render(<ArtifactIdDisplay artifactId={id} />);

    const text = screen.getByText(id);
    expect(text.className).toContain("select-all");
    expect(text.className).toContain("font-mono");
    expect(text.getAttribute("translate")).toBe("no");
    // No copy button, so it can sit inside a link.
    expect(screen.queryByRole("button")).toBeNull();
  });
});

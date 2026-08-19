import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/ui/button", () => ({
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props} />
  ),
}));

import { ConsoleAccessPage } from "./ConsoleAccessPage";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ConsoleAccessPage", () => {
  it("explains why an authenticated email was rejected", () => {
    render(
      <ConsoleAccessPage
        access={{
          status: "forbidden",
          principal: { email: "viewer@example.com" },
        }}
        providers={["github"]}
      />,
    );

    expect(screen.getByText("Access denied")).toBeTruthy();
    expect(
      screen.getByText("viewer@example.com is not in the console allowlist."),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Continue with GitHub" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
  });

  it("starts the selected social sign-in and reports invalid responses", async () => {
    const fetchMock = vi.fn(async () =>
      Promise.resolve(
        new Response(JSON.stringify({}), {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(
      <ConsoleAccessPage
        access={{ status: "unauthenticated" }}
        providers={["google", "github"]}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Continue with GitHub" }),
    );

    expect((await screen.findByRole("alert")).textContent).toContain(
      "The identity provider did not return a sign-in URL.",
    );
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/sign-in/social", {
      body: JSON.stringify({ callbackURL: "/", provider: "github" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
  });
});

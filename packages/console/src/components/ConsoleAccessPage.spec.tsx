import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/ui/button", () => ({
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props} />
  ),
}));

import { ConsoleAccessPage, signInCallbackURL } from "./ConsoleAccessPage";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ConsoleAccessPage", () => {
  it("sends JSON when signing a forbidden identity out of a strict auth handler", async () => {
    const reload = vi.fn();
    vi.stubGlobal(
      "window",
      new Proxy(window, {
        get: (target, key) =>
          key === "location" ? { reload } : Reflect.get(target, key),
      }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init: RequestInit) => {
        const request = new Request(
          "https://console.example/api/auth/sign-out",
          init,
        );
        const acceptsRequest =
          request.method === "POST" &&
          request.headers.get("content-type") === "application/json" &&
          (await request.text()) === "{}";
        return new Response(null, { status: acceptsRequest ? 200 : 415 });
      }),
    );
    render(
      <ConsoleAccessPage
        access={{
          status: "forbidden",
          principal: { email: "viewer@example.com" },
        }}
        providers={["github"]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    await waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(screen.queryByRole("alert")).toBeNull();
  });

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

  it("returns from sign-in to the page that asked for it", async () => {
    window.history.replaceState(
      null,
      "",
      "/native-builds/019a0000-0000-7000-8000-00000000b001?patchesBefore=x",
    );
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(JSON.stringify({}), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(
      <ConsoleAccessPage
        access={{ status: "unauthenticated" }}
        providers={["github"]}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Continue with GitHub" }),
    );

    await screen.findByRole("alert");
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1].body))).toEqual({
      callbackURL:
        "/native-builds/019a0000-0000-7000-8000-00000000b001?patchesBefore=x",
      provider: "github",
    });
    window.history.replaceState(null, "", "/");
  });
});

describe("signInCallbackURL", () => {
  it("keeps a path on this console", () => {
    expect(
      signInCallbackURL({ pathname: "/native-builds/b1", search: "?a=1" }),
    ).toBe("/native-builds/b1?a=1");
    expect(signInCallbackURL({ pathname: "/", search: "" })).toBe("/");
  });

  it("returns to the root for anything that could leave the console", () => {
    for (const pathname of [
      "//evil.example/native-builds",
      "/\\evil.example",
      "https://evil.example/",
      "evil.example",
      "",
    ]) {
      expect(signInCallbackURL({ pathname, search: "" })).toBe("/");
    }
  });
});

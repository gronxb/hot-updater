import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Button, buttonVariants } from "./button";

const classes = (value: string) => value.split(/\s+/);

describe("buttonVariants", () => {
  // Links take buttonVariants' classes directly, without Button's merge, so
  // the variant's border color has to replace the base's transparent one.
  it("draws an outline's border, not the base's transparent one", () => {
    const outline = classes(buttonVariants({ variant: "outline" }));

    expect(outline).toContain("border-border");
    expect(outline).not.toContain("border-transparent");
  });

  it("keeps the base's transparent border where a variant sets none", () => {
    expect(classes(buttonVariants({ variant: "ghost" }))).toContain(
      "border-transparent",
    );
  });

  it("lets a className override the size's height and the base's width", () => {
    const merged = classes(
      buttonVariants({
        className: "h-auto min-h-11 w-full py-2 whitespace-normal",
        variant: "outline",
      }),
    );

    expect(merged).toEqual(
      expect.arrayContaining([
        "h-auto",
        "min-h-11",
        "w-full",
        "py-2",
        "whitespace-normal",
      ]),
    );
    expect(merged).not.toContain("h-7");
    expect(merged).not.toContain("whitespace-nowrap");
  });

  it("gives a link the same classes as a Button of the same variant", () => {
    render(
      <>
        <Button variant="outline">Button</Button>
        <a className={buttonVariants({ variant: "outline" })} href="/">
          Link
        </a>
      </>,
    );

    expect(screen.getByRole("link", { name: "Link" }).className).toBe(
      screen.getByRole("button", { name: "Button" }).className,
    );
  });
});

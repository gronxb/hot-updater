import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Dialog, DialogContent, DialogFooter, DialogTitle } from "./dialog";
import { Input } from "./input";
import { Switch } from "./switch";
import { Tabs, TabsList, TabsTrigger } from "./tabs";
import { Textarea } from "./textarea";

afterEach(cleanup);

// Below md, where the Console is a phone's: 16 px text so iOS doesn't zoom on
// focus, 44 px targets, and dialogs that fit the dynamic viewport. Desktop
// classes stay as they were.
describe("phone sizes on the shared controls", () => {
  it("keeps inputs at 16 px and 44 px tall on a phone, compact from md", () => {
    render(
      <>
        <Input aria-label="Name" />
        <Textarea aria-label="Notes" />
      </>,
    );
    const input = screen.getByLabelText("Name");
    expect(input.className).toContain("max-md:text-base");
    expect(input.className).toContain("max-md:h-11");
    expect(input.className).toContain("md:text-xs/relaxed");
    expect(screen.getByLabelText("Notes").className).toContain(
      "max-md:text-base",
    );
  });

  it("gives a dialog a 44 px close, 44 px footer actions, and a height within the dynamic viewport", () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Title</DialogTitle>
          <DialogFooter>
            <button type="button">Save</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog.className).toContain("max-h-[calc(100dvh-2rem)]");
    expect(dialog.className).toContain("overflow-y-auto");
    expect(screen.getByRole("button", { name: "Close" }).className).toContain(
      "max-md:size-11",
    );
    expect(
      screen.getByRole("button", { name: "Save" }).parentElement!.className,
    ).toContain("max-sm:*:min-h-11");
  });

  it("widens a switch's hit area on a phone only", () => {
    render(<Switch aria-label="Enabled" />);
    const toggle = screen.getByRole("switch", { name: "Enabled" });
    expect(toggle.className).toContain("after:-inset-y-3");
    expect(toggle.className).toContain("md:after:hidden");
  });

  it("gives a tab a 44 px hit area on a phone without growing its row", () => {
    render(
      <Tabs defaultValue="a">
        <TabsList>
          <TabsTrigger value="a">24 hours</TabsTrigger>
        </TabsList>
      </Tabs>,
    );
    const tab = screen.getByRole("tab", { name: "24 hours" });
    expect(tab.className).toContain("max-md:before:-inset-y-1");
    expect(tab.className).toContain("max-md:before:absolute");
  });
});

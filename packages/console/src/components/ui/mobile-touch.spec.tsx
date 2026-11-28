import { cleanup, render, screen } from "@testing-library/react";
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { Dialog, DialogContent, DialogFooter, DialogTitle } from "./dialog";
import { Input } from "./input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectTrigger,
  SelectValue,
} from "./select";
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

  it("widens a switch's hit area to 44 px on a phone only", () => {
    render(<Switch aria-label="Enabled" />);
    const toggle = screen.getByRole("switch", { name: "Enabled" });
    // `::after` is placed against the padding box, inside the 2 px border:
    // 16 + 2 * 14 = 44 tall and 32 + 2 * 6 = 44 wide.
    expect(toggle.className).toContain("border-2");
    expect(toggle.className).toContain("after:-inset-y-3.5");
    expect(toggle.className).toContain("after:-inset-x-1.5");
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

  it("gives a select's options 44 px rows on a phone, compact from md, and a popup as wide as its longest name", () => {
    const long = "qa-rc29-second-ota-20261003";
    render(
      <Select defaultOpen defaultValue="production">
        <SelectTrigger aria-label="Channel">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value="production">production</SelectItem>
            <SelectItem value={long}>{long}</SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>,
    );
    const option = screen.getByRole("option", { name: long });
    expect(option.className).toContain("max-md:min-h-11");
    expect(option.className).toContain("min-h-7");
    // The check mark sits in the row's right padding, never over a name.
    expect(option.className).toContain("pr-8");
    const popup = option.closest("[data-slot=select-content]")!;
    // As wide as the longest name, never narrower than the trigger, and within
    // the screen; a name longer than that wraps whole instead of clipping.
    expect(popup.className).toContain("w-max");
    expect(popup.className).toContain("min-w-(--anchor-width)");
    expect(popup.className).toContain("max-w-(--available-width)");
    expect(screen.getByText(long).className).toContain(
      "[overflow-wrap:anywhere]",
    );
  });

  it.each([
    [390, "false"],
    [1280, "true"],
  ])(
    "at %i px opens a select's list from its top below the trigger on a phone, and over the trigger from md",
    async (width, alignsWithTrigger) => {
      const innerWidth = window.innerWidth;
      window.innerWidth = width;
      try {
        await act(async () => {
          render(
            <Select defaultOpen defaultValue="production">
              <SelectTrigger aria-label="Channel">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="production">production</SelectItem>
              </SelectContent>
            </Select>,
          );
        });
        expect(
          screen
            .getByRole("option", { name: "production" })
            .closest("[data-slot=select-content]")!
            .getAttribute("data-align-trigger"),
        ).toBe(alignsWithTrigger);
      } finally {
        window.innerWidth = innerWidth;
      }
    },
  );

  it("hides a select's scroll arrows on a phone, where they would cover an option", () => {
    render(
      <Select defaultOpen defaultValue="production">
        <SelectTrigger aria-label="Channel">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="production">production</SelectItem>
          <SelectScrollUpButton keepMounted />
          <SelectScrollDownButton keepMounted />
        </SelectContent>
      </Select>,
    );
    for (const slot of [
      "select-scroll-up-button",
      "select-scroll-down-button",
    ]) {
      const arrow = document.querySelector(`[data-slot=${slot}]`)!;
      expect(arrow.className).toContain("max-md:hidden");
    }
  });
});

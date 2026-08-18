import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "./alert-dialog";
import { Button } from "./button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "./dialog";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./select";
import { Slider } from "./slider";
import { Switch } from "./switch";

const channelItems = [
  { label: "Production", value: "production" },
  { label: "Staging", value: "staging" },
];

describe("Base UI primitives", () => {
  afterEach(cleanup);

  it("opens and closes a composed dialog without adding a wrapper element", () => {
    render(
      <Dialog>
        <DialogTrigger render={<Button variant="outline" />}>
          Manage channels
        </DialogTrigger>
        <DialogContent>
          <DialogTitle>Channels</DialogTitle>
          <DialogDescription>Manage deployment channels.</DialogDescription>
        </DialogContent>
      </Dialog>,
    );

    const trigger = screen.getByRole("button", { name: "Manage channels" });
    expect(trigger.parentElement?.querySelector("button")).toBe(trigger);

    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "Channels" })).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog", { name: "Channels" })).toBeNull();
  });

  it("keeps destructive confirmation open until its action owner closes it", () => {
    render(
      <AlertDialog>
        <AlertDialogTrigger render={<Button />}>Delete</AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogTitle>Delete deployment?</AlertDialogTitle>
          <AlertDialogDescription>
            This cannot be undone.
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction>Confirm</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(
      screen.getByRole("alertdialog", { name: "Delete deployment?" }),
    ).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      screen.queryByRole("alertdialog", { name: "Delete deployment?" }),
    ).toBeNull();
  });

  it("selects an item from the Base UI item model", () => {
    function SelectExample() {
      const [value, setValue] = useState("production");

      return (
        <Select
          items={channelItems}
          onValueChange={(nextValue) => setValue(nextValue ?? "production")}
          value={value}
        >
          <SelectTrigger aria-label="Channel">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {channelItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      );
    }

    render(<SelectExample />);
    const trigger = screen.getByRole("combobox", { name: "Channel" });
    expect(trigger.textContent).toContain("Production");

    fireEvent.click(trigger);
    const option = screen.getByRole("option", { name: "Staging" });
    fireEvent.pointerDown(option);
    fireEvent.click(option);

    expect(trigger.textContent).toContain("Staging");
  });

  it("reports switch state changes with the Base UI checked callback", () => {
    const onCheckedChange = vi.fn();
    render(
      <Switch
        aria-label="Enable deployment"
        onCheckedChange={onCheckedChange}
      />,
    );

    fireEvent.click(screen.getByRole("switch", { name: "Enable deployment" }));

    expect(onCheckedChange).toHaveBeenCalledWith(true, expect.any(Object));
  });

  it("renders one thumb for a scalar rollout value", () => {
    const { container } = render(
      <Slider aria-label="Rollout percentage" value={500} max={1_000} />,
    );

    expect(
      container.querySelectorAll('[data-slot="slider-thumb"]'),
    ).toHaveLength(1);
  });
});

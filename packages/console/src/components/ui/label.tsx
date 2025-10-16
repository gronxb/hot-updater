import type { Component, ComponentProps } from "solid-js";
import { splitProps } from "solid-js";

import { cn } from "@/lib/utils";

const Label: Component<ComponentProps<"label">> = (props) => {
  const [local, others] = splitProps(props, ["class"]);
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: label control is passed via children props
    <label
      class={cn(
        "text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70",
        local.class,
      )}
      {...others}
    />
  );
};

export { Label };

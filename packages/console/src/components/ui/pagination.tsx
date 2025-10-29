import * as PaginationPrimitive from "@kobalte/core/pagination";
import type { PolymorphicProps } from "@kobalte/core/polymorphic";
import type { JSX, ValidComponent } from "solid-js";
import { splitProps } from "solid-js";

import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const PaginationItems = PaginationPrimitive.Items;

type PaginationRootProps<T extends ValidComponent = "nav"> =
  PaginationPrimitive.PaginationRootProps<T> & { class?: string | undefined };

const Pagination = <T extends ValidComponent = "nav">(
  props: PolymorphicProps<T, PaginationRootProps<T>>,
) => {
  const [local, others] = splitProps(props as PaginationRootProps, ["class"]);
  return (
    <PaginationPrimitive.Root
      class={cn(
        "[&>*]:flex [&>*]:flex-row [&>*]:items-center [&>*]:gap-1",
        local.class,
      )}
      {...others}
    />
  );
};

type PaginationItemProps<T extends ValidComponent = "button"> =
  PaginationPrimitive.PaginationItemProps<T> & { class?: string | undefined };

const PaginationItem = <T extends ValidComponent = "button">(
  props: PolymorphicProps<T, PaginationItemProps<T>>,
) => {
  const [local, others] = splitProps(props as PaginationItemProps, ["class"]);
  return (
    <PaginationPrimitive.Item
      class={cn(
        buttonVariants({
          variant: "ghost",
        }),
        "size-10 data-[current]:border",
        local.class,
      )}
      {...others}
    />
  );
};

type PaginationEllipsisProps<T extends ValidComponent = "div"> =
  PaginationPrimitive.PaginationEllipsisProps<T> & {
    class?: string | undefined;
  };

const PaginationEllipsis = <T extends ValidComponent = "div">(
  props: PolymorphicProps<T, PaginationEllipsisProps<T>>,
) => {
  const [local, others] = splitProps(props as PaginationEllipsisProps, [
    "class",
  ]);
  return (
    <PaginationPrimitive.Ellipsis
      class={cn("flex size-10 items-center justify-center", local.class)}
      {...others}
    >
      {/* biome-ignore lint/a11y/noSvgWithoutTitle: decorative icon */}
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        class="size-4"
      >
        <circle cx="12" cy="12" r="1" />
        <circle cx="19" cy="12" r="1" />
        <circle cx="5" cy="12" r="1" />
      </svg>
      <span class="sr-only">More pages</span>
    </PaginationPrimitive.Ellipsis>
  );
};

type PaginationPreviousProps<T extends ValidComponent = "button"> =
  PaginationPrimitive.PaginationPreviousProps<T> & {
    class?: string | undefined;
    children?: JSX.Element;
  };

const PaginationPrevious = <T extends ValidComponent = "button">(
  props: PolymorphicProps<T, PaginationPreviousProps<T>>,
) => {
  const [local, others] = splitProps(props as PaginationPreviousProps, [
    "class",
    "children",
  ]);
  return (
    <PaginationPrimitive.Previous
      class={cn(
        buttonVariants({
          variant: "ghost",
        }),
        "gap-1 pl-2.5",
        local.class,
      )}
      {...others}
    >
      {local.children ?? (
        <>
          {/* biome-ignore lint/a11y/noSvgWithoutTitle: decorative icon */}
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            class="size-4"
          >
            <path d="M15 6l-6 6l6 6" />
          </svg>
          <span>Previous</span>
        </>
      )}
    </PaginationPrimitive.Previous>
  );
};

type PaginationNextProps<T extends ValidComponent = "button"> =
  PaginationPrimitive.PaginationNextProps<T> & {
    class?: string | undefined;
    children?: JSX.Element;
  };

const PaginationNext = <T extends ValidComponent = "button">(
  props: PolymorphicProps<T, PaginationNextProps<T>>,
) => {
  const [local, others] = splitProps(props as PaginationNextProps, [
    "class",
    "children",
  ]);
  return (
    <PaginationPrimitive.Next
      class={cn(
        buttonVariants({
          variant: "ghost",
        }),
        "gap-1 pl-2.5",
        local.class,
      )}
      {...others}
    >
      {local.children ?? (
        <>
          <span>Next</span>
          {/* biome-ignore lint/a11y/noSvgWithoutTitle: decorative icon */}
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            class="size-4"
          >
            <path d="M9 6l6 6l-6 6" />
          </svg>
        </>
      )}
    </PaginationPrimitive.Next>
  );
};

export {
  Pagination,
  PaginationItems,
  PaginationItem,
  PaginationEllipsis,
  PaginationPrevious,
  PaginationNext,
};

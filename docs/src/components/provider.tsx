"use client";
import type { Framework } from "fumadocs-core/framework";
import { RootProvider } from "fumadocs-ui/provider/waku";
import type { ComponentProps } from "react";
import { Link } from "waku";

const PrefetchLink = (({ href, children, ...props }) => {
  const { ref: _ref, ...linkProps } = props as Record<string, unknown> & {
    ref?: unknown;
  };

  return (
    <Link
      to={href!}
      unstable_prefetchOnView
      {...(linkProps as Record<string, never>)}
    >
      {children}
    </Link>
  );
}) satisfies Framework["Link"];

export function Provider({
  children,
}: {
  children: ComponentProps<typeof RootProvider>["children"];
}) {
  return (
    <RootProvider
      components={{
        Link: PrefetchLink,
      }}
      search={{
        options: {
          type: "static",
        },
      }}
    >
      {children}
    </RootProvider>
  );
}

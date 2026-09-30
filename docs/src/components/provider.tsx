"use client";
import type { Framework } from "fumadocs-core/framework";
import { RootProvider } from "fumadocs-ui/provider/waku";
import type { ComponentProps } from "react";
import { Link } from "waku";

type WakuLinkChildren = ComponentProps<typeof Link>["children"];

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
      {children as WakuLinkChildren}
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

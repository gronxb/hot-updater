"use client";
import type { Framework } from "fumadocs-core/framework";
import { RootProvider } from "fumadocs-ui/provider/waku";
import type { ComponentProps } from "react";
import { Link } from "waku";
import { useRouter } from "waku/router/client";

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

// Frozen archives under /docs/<version>; search stays within the one open.
const archivedVersions = ["v1.0", "v0"];

export function Provider({
  children,
}: {
  children: ComponentProps<typeof RootProvider>["children"];
}) {
  const { path } = useRouter();
  const docsVersion =
    archivedVersions.find(
      (version) =>
        path === `/docs/${version}` || path.startsWith(`/docs/${version}/`),
    ) ?? "latest";

  return (
    <RootProvider
      components={{
        Link: PrefetchLink,
      }}
      search={{
        options: {
          defaultTag: docsVersion,
          type: "static",
        },
      }}
    >
      {children}
    </RootProvider>
  );
}

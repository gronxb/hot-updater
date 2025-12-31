"use client";
import type { Framework } from "fumadocs-core/framework";
import { RootProvider } from "fumadocs-ui/provider/waku";
import type { ReactNode } from "react";
import { Link } from "waku";

const PrefetchLink: Framework["Link"] = ({ href, children, ...props }) => {
  return (
    <Link to={href!} unstable_prefetchOnView {...props}>
      {children}
    </Link>
  );
};

export function Provider({ children }: { children: ReactNode }) {
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

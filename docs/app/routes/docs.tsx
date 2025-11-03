import { createFileRoute, Outlet } from "@tanstack/react-router";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import type { ReactNode } from "react";
import { baseOptions } from "~/lib/layout.shared";
import { loader } from "~/lib/source";

export const Route = createFileRoute("/docs")({
  component: DocsLayoutComponent,
});

function DocsLayoutComponent(): ReactNode {
  return (
    <DocsLayout tree={loader.pageTree} {...baseOptions}>
      <Outlet />
    </DocsLayout>
  );
}

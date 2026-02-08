import { SidebarTrigger } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

export interface AnalyticsShellProps {
  title: string;
  breadcrumbs?: React.ReactNode;
  controls?: React.ReactNode;
  chips?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

export function AnalyticsShell({
  title,
  breadcrumbs,
  controls,
  chips,
  children,
  className,
}: AnalyticsShellProps) {
  return (
    <div className={cn("analytics-shell", className)}>
      <header className="analytics-command-header">
        <div className="flex items-center gap-2 min-w-0">
          <SidebarTrigger className="-ml-1 shrink-0" />
          <div className="analytics-title-wrap">
            <h1 className="analytics-title">{title}</h1>
          </div>
          {chips ? <div className="analytics-chip-row">{chips}</div> : null}
        </div>
        {controls ? (
          <div className="flex items-center gap-2 shrink-0">{controls}</div>
        ) : null}
      </header>
      <main className="analytics-shell-body">
        {breadcrumbs ? (
          <div className="analytics-body-breadcrumb">{breadcrumbs}</div>
        ) : null}
        {children}
      </main>
    </div>
  );
}

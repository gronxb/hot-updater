import { cn } from "@/lib/utils";

export interface AnalyticsSectionProps {
  title: string;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

export function AnalyticsSection({
  title,
  description,
  action,
  children,
  className,
}: AnalyticsSectionProps) {
  return (
    <section className={cn("analytics-section", className)}>
      <div className="analytics-section-head">
        <div className="min-w-0">
          <h2 className="analytics-section-title">{title}</h2>
          {description ? (
            <p className="analytics-section-description">{description}</p>
          ) : null}
        </div>
        {action ? (
          <div className="w-full md:w-auto md:shrink-0">{action}</div>
        ) : null}
      </div>
      {children}
    </section>
  );
}

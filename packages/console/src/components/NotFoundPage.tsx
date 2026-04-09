import { Link } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";

const homeSearch = {
  channel: undefined,
  platform: undefined,
  page: undefined,
  after: undefined,
  before: undefined,
  bundleId: undefined,
} as const;

export function NotFoundPage() {
  return (
    <div className="flex min-h-svh flex-1 items-center justify-center px-6 py-10">
      <section className="flex max-w-md flex-col items-center text-center">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          Page not found
        </h1>
        <Button asChild size="lg" className="mt-6">
          <Link to="/" search={homeSearch}>
            Go to home
          </Link>
        </Button>
      </section>
    </div>
  );
}

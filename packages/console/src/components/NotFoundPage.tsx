import { Link, useRouterState } from "@tanstack/react-router";
import { ArrowLeft, History, TriangleAlert } from "lucide-react";
import { HotUpdaterLogo } from "@/components/HotUpdaterLogo";
import { Button } from "@/components/ui/button";

const homeSearch = {
  channel: undefined,
  platform: undefined,
  offset: undefined,
  bundleId: undefined,
} as const;

export function NotFoundPage() {
  const attemptedPath = useRouterState({
    select: (state) => state.location.href,
  });

  return (
    <div className="console-not-found relative flex min-h-svh flex-1 items-center overflow-hidden">
      <div className="console-not-found-grid absolute inset-0" />
      <div className="console-not-found-noise absolute inset-0" />
      <div className="pointer-events-none absolute -left-20 top-10 h-72 w-72 rounded-full bg-[radial-gradient(circle_at_center,rgba(255,153,92,0.32),transparent_68%)] blur-3xl motion-safe:animate-[console-signal-drift_18s_ease-in-out_infinite]" />
      <div className="pointer-events-none absolute bottom-[-9rem] right-[-6rem] h-[30rem] w-[30rem] rounded-full bg-[radial-gradient(circle_at_center,rgba(255,111,43,0.28),transparent_62%)] blur-3xl motion-safe:animate-[console-signal-drift_22s_ease-in-out_infinite_reverse]" />

      <section className="relative z-10 mx-auto flex w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
        <div className="relative grid w-full overflow-hidden rounded-[2rem] border border-white/10 bg-[#120d0a]/85 shadow-[0_32px_120px_rgba(0,0,0,0.5)] backdrop-blur md:grid-cols-[minmax(0,1.1fr)_22rem]">
          <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(140deg,rgba(255,132,64,0.16),transparent_34%,transparent_60%,rgba(255,205,167,0.06))]" />
          <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-[linear-gradient(90deg,transparent,rgba(255,177,120,0.7),transparent)]" />

          <div className="relative flex flex-col justify-between gap-10 p-6 sm:p-8 lg:p-12">
            <div className="space-y-8">
              <div className="flex flex-wrap items-center gap-3">
                <span className="console-not-found-kicker rounded-full border border-white/12 bg-white/6 px-3 py-1.5 text-[10px] text-stone-200/90">
                  404 / SIGNAL LOST
                </span>
                <span className="rounded-full border border-orange-300/18 bg-orange-200/8 px-3 py-1.5 text-[10px] uppercase tracking-[0.28em] text-orange-100/80">
                  Hot Updater Console
                </span>
              </div>

              <div className="flex items-center gap-4">
                <div className="rounded-[1.35rem] border border-white/10 bg-white/6 p-3 shadow-[0_18px_40px_rgba(0,0,0,0.28)]">
                  <HotUpdaterLogo className="h-12 w-12" />
                </div>
                <div className="space-y-1">
                  <p className="console-not-found-kicker text-stone-300/75">
                    ROUTE STATUS
                  </p>
                  <p className="text-sm text-stone-200">
                    The page burned out before the console could render it.
                  </p>
                </div>
              </div>

              <div className="space-y-5">
                <p className="console-not-found-number text-[clamp(5.5rem,18vw,11rem)] leading-none text-white">
                  404
                </p>
                <div className="max-w-3xl space-y-4">
                  <h1 className="console-not-found-title text-4xl leading-none text-white sm:text-5xl lg:text-6xl">
                    That route does not exist in this console.
                  </h1>
                  <p className="max-w-2xl text-sm leading-7 text-stone-300 sm:text-base">
                    Use the stable path back to your bundles list, or step back
                    to the previous screen and try a known route.
                  </p>
                </div>
              </div>

              <div className="flex flex-col gap-3 sm:flex-row">
                <Button
                  asChild
                  size="lg"
                  className="h-11 rounded-full px-5 text-sm font-semibold shadow-[0_16px_40px_rgba(255,111,43,0.28)]"
                >
                  <Link to="/" search={homeSearch}>
                    <ArrowLeft />
                    Return to bundles
                  </Link>
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="lg"
                  className="h-11 rounded-full border-white/14 bg-white/6 px-5 text-sm text-stone-100 hover:bg-white/10"
                  onClick={() => window.history.back()}
                >
                  <History />
                  Go back
                </Button>
              </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <div className="rounded-[1.4rem] border border-white/10 bg-black/18 p-5">
                <p className="console-not-found-kicker text-stone-400/80">
                  Attempted path
                </p>
                <p className="console-not-found-path mt-3 break-all text-sm text-stone-100">
                  {attemptedPath}
                </p>
              </div>
              <div className="rounded-[1.4rem] border border-orange-200/10 bg-orange-200/6 p-5">
                <div className="flex items-start gap-3">
                  <TriangleAlert className="mt-0.5 h-4 w-4 text-orange-200" />
                  <div className="space-y-1.5 text-sm text-stone-200">
                    <p className="console-not-found-kicker text-orange-100/80">
                      Recovery note
                    </p>
                    <p>
                      Check the URL, or navigate with the sidebar to stay on
                      registered console routes.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <aside className="relative border-t border-white/10 bg-black/16 p-6 sm:p-8 md:border-t-0 md:border-l">
            <div className="flex h-full flex-col justify-between gap-8">
              <div className="space-y-6">
                <div>
                  <p className="console-not-found-kicker text-stone-400/75">
                    Diagnostic panel
                  </p>
                  <h2 className="console-not-found-title mt-3 text-2xl leading-tight text-white">
                    Route registry mismatch
                  </h2>
                </div>

                <div className="space-y-3 rounded-[1.5rem] border border-white/10 bg-white/5 p-5">
                  <p className="console-not-found-kicker text-stone-300/70">
                    Quick recovery
                  </p>
                  <div className="space-y-3 text-sm leading-6 text-stone-300">
                    <p>1. Return to the bundles index.</p>
                    <p>2. Re-open the screen from sidebar navigation.</p>
                    <p>3. If you bookmarked this path, update the saved URL.</p>
                  </div>
                </div>
              </div>

              <div className="rounded-[1.5rem] border border-orange-200/12 bg-[linear-gradient(180deg,rgba(255,118,58,0.14),rgba(255,118,58,0.03))] p-5">
                <p className="console-not-found-kicker text-orange-100/80">
                  Status
                </p>
                <div className="mt-3 flex items-center gap-3 text-sm text-stone-100">
                  <span className="inline-flex h-2.5 w-2.5 rounded-full bg-orange-300 shadow-[0_0_18px_rgba(255,152,92,0.9)] motion-safe:animate-[console-signal-pulse_2.1s_ease-in-out_infinite]" />
                  Routing fallback active
                </div>
              </div>
            </div>
          </aside>
        </div>
      </section>
    </div>
  );
}

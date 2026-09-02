import { hierarchy, pack } from "d3-hierarchy";
import { Heart } from "lucide-react";

import sponsorsData from "../../public/sponsors.json";

interface Sponsor {
  login: string;
  avatarUrl: string;
  name: string | null;
  url: string;
  amountInCents?: number;
  displayWeight?: number;
}

interface SponsorNode {
  sponsor?: Sponsor;
  children?: SponsorNode[];
}

const PACKING_SIZE = 720;
const PACKING_PADDING = 5;
const UNKNOWN_TIER_RATIO = 0.25;

function getPackedSponsors(sponsors: Sponsor[]) {
  const knownAmounts = sponsors
    .map((sponsor) => sponsor.amountInCents ?? 0)
    .filter((amount) => amount > 0);
  const smallestKnownAmount = Math.min(...knownAmounts);
  const unknownTierWeight = Number.isFinite(smallestKnownAmount)
    ? smallestKnownAmount * UNKNOWN_TIER_RATIO
    : 1;

  const root = hierarchy<SponsorNode>(
    {
      children: sponsors.map((sponsor) => ({ sponsor })),
    },
    (node) => node.children,
  )
    .sum((node) => {
      if (!node.sponsor) {
        return 0;
      }

      const weight =
        node.sponsor.displayWeight ?? node.sponsor.amountInCents ?? 0;
      return weight > 0 ? weight : unknownTierWeight;
    })
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));

  return pack<SponsorNode>()
    .size([PACKING_SIZE, PACKING_SIZE])
    .padding(PACKING_PADDING)(root)
    .leaves()
    .map((node) => ({
      sponsor: node.data.sponsor as Sponsor,
      x: node.x,
      y: node.y,
      radius: node.r,
    }));
}

export function LandingSponsors() {
  const sponsors = sponsorsData.sponsors as Sponsor[];
  const hasSponsors = sponsors.length > 0;
  const packedSponsors = getPackedSponsors(sponsors);

  return (
    <section className="relative overflow-hidden border-b border-fd-border bg-fd-background">
      <div className="pointer-events-none absolute inset-x-0 top-1/2 mx-auto h-96 max-w-4xl -translate-y-1/2 rounded-full bg-[radial-gradient(circle,rgba(249,115,22,0.09)_0,transparent_68%)] blur-3xl dark:bg-[radial-gradient(circle,rgba(249,115,22,0.12)_0,transparent_68%)]" />
      <div className="relative mx-auto max-w-7xl px-4 py-16 sm:px-6 sm:py-24 lg:px-8 lg:py-28">
        <div
          className={hasSponsors ? "mb-8 text-center sm:mb-10" : "text-center"}
        >
          <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-pink-500/20 bg-pink-500/8 px-3 py-1.5">
            <Heart className="size-3.5 fill-pink-500 text-pink-500" />
            <span className="text-xs font-semibold uppercase tracking-[0.16em] text-pink-500">
              Past &amp; present
            </span>
          </div>
          <h2 className="text-2xl font-bold tracking-tight text-fd-foreground sm:text-3xl lg:text-4xl">
            {hasSponsors ? "Built with our sponsors" : "Become a Sponsor"}
          </h2>
          <p className="mx-auto mt-3 max-w-2xl text-base leading-relaxed text-fd-muted-foreground sm:mt-4 sm:text-lg">
            {hasSponsors
              ? "Every person and team who has supported Hot Updater has a place here. Thank you for keeping open source moving."
              : "Support Hot Updater development and help us build the best OTA update solution for React Native."}
          </p>
        </div>

        {hasSponsors ? (
          <div className="relative mx-auto aspect-square w-full max-w-[45rem] rounded-full border border-orange-500/20 bg-[radial-gradient(circle_at_40%_35%,rgba(249,115,22,0.12),transparent_68%)] shadow-[inset_0_0_90px_rgba(249,115,22,0.06)] dark:border-orange-400/20 dark:bg-[radial-gradient(circle_at_40%_35%,rgba(249,115,22,0.16),transparent_68%)]">
            <div className="pointer-events-none absolute inset-[4%] rounded-full border border-dashed border-orange-500/10" />
            <ul className="absolute inset-0 m-0 list-none p-0">
              {packedSponsors.map(({ sponsor, x, y, radius }) => {
                const sponsorName = sponsor.name || sponsor.login;

                return (
                  <li
                    key={sponsor.login}
                    className="absolute"
                    style={{
                      left: `${((x - radius) / PACKING_SIZE) * 100}%`,
                      top: `${((y - radius) / PACKING_SIZE) * 100}%`,
                      width: `${((radius * 2) / PACKING_SIZE) * 100}%`,
                      height: `${((radius * 2) / PACKING_SIZE) * 100}%`,
                    }}
                  >
                    <a
                      href={sponsor.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={`View ${sponsorName}'s GitHub profile`}
                      className="group relative block size-full rounded-full outline-none transition duration-300 hover:z-10 hover:scale-[1.06] focus-visible:z-10 focus-visible:scale-[1.06] focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-4 focus-visible:ring-offset-fd-background motion-reduce:transition-none"
                    >
                      <span className="absolute inset-0 overflow-hidden rounded-full border border-white/60 bg-fd-card shadow-[0_12px_35px_-16px_rgba(0,0,0,0.55)] ring-1 ring-black/5 transition-shadow duration-300 group-hover:shadow-[0_16px_45px_-14px_rgba(249,115,22,0.5)] dark:border-white/15 dark:ring-white/10">
                        <img
                          src={sponsor.avatarUrl}
                          alt=""
                          width={Math.ceil(radius * 2)}
                          height={Math.ceil(radius * 2)}
                          loading="lazy"
                          decoding="async"
                          className="size-full object-cover saturate-[0.88] transition duration-300 group-hover:scale-105 group-hover:saturate-100 motion-reduce:transition-none"
                        />
                        <span className="absolute inset-0 bg-linear-to-t from-black/30 via-transparent to-white/10 opacity-60 transition-opacity group-hover:opacity-30" />
                      </span>

                      <span className="pointer-events-none absolute left-1/2 top-full z-20 mt-2 -translate-x-1/2 translate-y-1 whitespace-nowrap rounded-md border border-fd-border bg-fd-popover px-2.5 py-1.5 text-xs font-medium text-fd-popover-foreground opacity-0 shadow-lg transition duration-200 group-hover:translate-y-0 group-hover:opacity-100 group-focus-visible:translate-y-0 group-focus-visible:opacity-100 motion-reduce:transition-none">
                        {sponsorName}
                      </span>
                    </a>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}

        {hasSponsors ? (
          <div className="mt-8 flex items-center justify-center gap-2 text-xs text-fd-muted-foreground">
            <span className="flex items-end gap-0.5" aria-hidden="true">
              <span className="size-1.5 rounded-full bg-orange-500/45" />
              <span className="size-2.5 rounded-full bg-orange-500/70" />
              <span className="size-3.5 rounded-full bg-orange-500" />
            </span>
            <span>Circle area reflects sponsorship level</span>
          </div>
        ) : null}

        <div
          className={
            hasSponsors
              ? "mt-10 text-center sm:mt-12"
              : "mt-6 text-center sm:mt-8"
          }
        >
          <a
            href="https://github.com/sponsors/gronxb"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 rounded-full border border-pink-500/30 bg-pink-500/10 px-5 py-2.5 text-sm font-semibold text-pink-500 transition-all hover:border-pink-500/50 hover:bg-pink-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pink-500 focus-visible:ring-offset-2 focus-visible:ring-offset-fd-background"
          >
            <Heart className="size-4" />
            Sponsor on GitHub
          </a>

          <div className="mt-6 flex flex-col items-center gap-2">
            <span className="text-[11px] uppercase tracking-[0.14em] text-fd-muted-foreground/80">
              Supported by
            </span>
            <a
              href="https://vercel.com/oss"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex rounded-md border border-fd-border/60 bg-fd-card/40 px-2.5 py-1.5 opacity-80 transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
            >
              <img
                alt="Vercel OSS Program"
                src="https://vercel.com/oss/program-badge-2026.svg"
                loading="lazy"
                className="h-6 w-auto"
              />
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}

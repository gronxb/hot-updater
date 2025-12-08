"use client";

import { Heart } from "lucide-react";
import { useEffect, useState } from "react";

interface Sponsor {
  login: string;
  avatarUrl: string;
  name: string | null;
  url: string;
}

interface SponsorsData {
  sponsors: Sponsor[];
  updatedAt: string;
}

export function LandingSponsors() {
  const [sponsors, setSponsors] = useState<Sponsor[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/sponsors.json")
      .then((res) => res.json())
      .then((data: SponsorsData) => {
        setSponsors(data.sponsors);
        setLoading(false);
      })
      .catch(() => {
        setLoading(false);
      });
  }, []);

  if (loading) {
    return (
      <div className="relative border-b border-fd-border bg-fd-background">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-16 sm:py-24">
          <div className="text-center">
            <div className="animate-pulse h-8 w-48 bg-fd-muted rounded mx-auto" />
          </div>
        </div>
      </div>
    );
  }

  if (sponsors.length === 0) {
    return null;
  }

  return (
    <div className="relative border-b border-fd-border bg-fd-background">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-16 sm:py-24">
        {/* Section header */}
        <div className="mb-10 sm:mb-14 text-center">
          <div className="inline-flex items-center gap-2 mb-4">
            <Heart className="w-5 h-5 text-pink-500 fill-pink-500" />
            <span className="text-sm font-medium text-pink-500 uppercase tracking-wider">
              Sponsors
            </span>
          </div>
          <h2 className="text-2xl sm:text-3xl lg:text-4xl font-bold tracking-tight text-fd-foreground">
            Thanks to our sponsors
          </h2>
          <p className="mt-3 sm:mt-4 text-base sm:text-lg text-fd-muted-foreground max-w-2xl mx-auto">
            Hot Updater is made possible by our amazing sponsors. Thank you for
            supporting open source!
          </p>
        </div>

        {/* Sponsors grid */}
        <div className="flex flex-wrap justify-center gap-4 sm:gap-6">
          {sponsors.map((sponsor) => (
            <a
              key={sponsor.login}
              href={sponsor.url}
              target="_blank"
              rel="noopener noreferrer"
              className="group flex flex-col items-center gap-2 p-3 sm:p-4 rounded-xl border border-transparent transition-all hover:border-fd-border hover:bg-fd-accent/50"
            >
              <div className="relative">
                <img
                  src={sponsor.avatarUrl}
                  alt={sponsor.name || sponsor.login}
                  className="w-14 h-14 sm:w-16 sm:h-16 rounded-full border-2 border-fd-border transition-all group-hover:border-orange-500/50 group-hover:scale-105"
                />
                <div className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full bg-pink-500 flex items-center justify-center">
                  <Heart className="w-3 h-3 text-white fill-white" />
                </div>
              </div>
              <span className="text-sm font-medium text-fd-foreground group-hover:text-orange-500 transition-colors">
                {sponsor.name || sponsor.login}
              </span>
            </a>
          ))}
        </div>

        {/* Become a sponsor CTA */}
        <div className="mt-10 sm:mt-14 text-center">
          <a
            href="https://github.com/sponsors/gronxb"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg border border-pink-500/30 bg-pink-500/10 text-pink-500 font-medium text-sm transition-all hover:bg-pink-500/20 hover:border-pink-500/50"
          >
            <Heart className="w-4 h-4" />
            Become a Sponsor
          </a>
        </div>
      </div>
    </div>
  );
}

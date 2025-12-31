import { LandingFeatures } from "@/components/landing-features";
import { LandingHero } from "@/components/landing-hero";
import { LandingSponsors } from "@/components/landing-sponsors";

export default function Home() {
  return (
    <>
      <LandingHero />
      <LandingFeatures />
      <LandingSponsors />
    </>
  );
}

export const getConfig = async () => {
  return {
    render: "static",
  };
};

import { LandingFeatures } from "@/components/landing-features";
import { LandingHero } from "@/components/landing-hero";

export default function Home() {
  return (
    <>
      <LandingHero />
      <LandingFeatures />
    </>
  );
}

export const getConfig = async () => {
  return {
    render: "static",
  };
};

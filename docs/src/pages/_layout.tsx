import "@/styles/globals.css";
import type { ReactNode } from "react";
import { Provider } from "@/components/provider";

export default function RootLayout({ children }: { children: ReactNode }) {
  const siteUrl = "https://hot-updater.dev";
  const ogImageUrl = `${siteUrl}/og.png`;
  const logoUrl = `${siteUrl}/logo.webp`;

  return (
    <>
      <meta charSet="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Hot Updater - Self-hosted OTA updates for React Native</title>

      {/* Favicon */}
      <link rel="icon" type="image/x-icon" href="/favicon.ico" />
      <link
        rel="icon"
        type="image/png"
        sizes="16x16"
        href="/favicon-16x16.png"
      />
      <link
        rel="icon"
        type="image/png"
        sizes="32x32"
        href="/favicon-32x32.png"
      />
      <link
        rel="apple-touch-icon"
        sizes="180x180"
        href="/apple-touch-icon.png"
      />

      {/* Preload Logo */}
      <link rel="preload" as="image" href="/logo.webp" type="image/webp" />

      {/* Primary Meta Tags */}
      <meta
        name="title"
        content="Hot Updater - Self-hosted OTA updates for React Native"
      />
      <meta
        name="description"
        content="Self-hosted over-the-air updates for React Native"
      />
      <meta name="theme-color" content="#f97316" />

      {/* Open Graph / Facebook */}
      <meta property="og:type" content="website" />
      <meta property="og:url" content={siteUrl} />
      <meta
        property="og:title"
        content="Hot Updater - Self-hosted OTA updates for React Native"
      />
      <meta
        property="og:description"
        content="Self-hosted over-the-air updates for React Native"
      />
      <meta property="og:image" content={ogImageUrl} />
      <meta property="og:image:width" content="4800" />
      <meta property="og:image:height" content="2520" />
      <meta property="og:image:type" content="image/png" />
      <meta property="og:site_name" content="Hot Updater" />
      <meta property="og:locale" content="en_US" />
      <meta property="og:logo" content={logoUrl} />

      {/* Twitter */}
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:url" content={siteUrl} />
      <meta
        name="twitter:title"
        content="Hot Updater - Self-hosted OTA updates for React Native"
      />
      <meta
        name="twitter:description"
        content="Self-hosted over-the-air updates for React Native"
      />
      <meta name="twitter:image" content={ogImageUrl} />

      <Provider>{children}</Provider>
    </>
  );
}

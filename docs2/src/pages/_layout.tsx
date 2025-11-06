import "@/styles/globals.css";
import type { ReactNode } from "react";
import { Provider } from "@/components/provider";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <meta charSet="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Hot Updater Docs</title>

      {/* Favicon */}
      <link rel="icon" type="image/x-icon" href="/favicon.ico" />
      <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png" />
      <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png" />
      <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />

      {/* Preload Logo */}
      <link rel="preload" as="image" href="/logo.webp" type="image/webp" />

      {/* Open Graph */}
      <meta property="og:type" content="website" />
      <meta property="og:site_name" content="Hot Updater" />
      <meta property="og:title" content="Hot Updater" />
      <meta property="og:description" content="Self-hosted over-the-air updates for React Native" />
      <meta property="og:image" content="https://hot-updater.dev/og.png" />
      <meta property="og:url" content="https://hot-updater.dev" />

      {/* Twitter Card */}
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:title" content="Hot Updater" />
      <meta name="twitter:description" content="Self-hosted over-the-air updates for React Native" />
      <meta name="twitter:image" content="https://hot-updater.dev/og.png" />

      {/* Additional Meta Tags */}
      <meta name="description" content="Self-hosted over-the-air updates for React Native" />
      <meta name="theme-color" content="#f97316" />

      <Provider>{children}</Provider>
    </>
  );
}

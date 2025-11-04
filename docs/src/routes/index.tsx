import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: HomePage,
});

function HomePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-24">
      <div className="text-center">
        <h1 className="text-4xl font-bold mb-4">Hot Updater</h1>
        <p className="text-xl text-muted-foreground mb-8">
          Self-Hostable OTA Updates for React Native
        </p>
        <a
          href="/docs"
          className="inline-flex items-center justify-center rounded-md bg-primary px-8 py-3 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          Get Started
        </a>
      </div>
    </main>
  );
}

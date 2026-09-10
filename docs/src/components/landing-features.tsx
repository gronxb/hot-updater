export function LandingFeatures() {
  const features = [
    {
      icon: "🚀",
      title: "Over-the-air updates",
      description: "Deploy updates without app store submissions",
    },
    {
      icon: "♻️",
      title: "Rollbacks",
      description: "Revert to previous versions in case of issues",
    },
    {
      icon: "🛠️",
      title: "Plugin system",
      description: "Customize build and deployment processes",
    },
    {
      icon: "📦",
      title: "Architecture support",
      description: "Works with new and legacy React Native versions",
    },
    {
      icon: "🔖",
      title: "Version targeting",
      description: "Semantic versioning and custom targeting rules",
    },
    {
      icon: "🖥️",
      title: "Web console",
      description: "Manage deployments and monitor updates",
    },
  ];

  return (
    <div className="relative border-b border-fd-border bg-fd-background">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-16 sm:py-24 lg:py-32">
        {/* Section header */}
        <div className="mb-12 sm:mb-16 text-center">
          <h2 className="text-2xl sm:text-3xl lg:text-4xl font-bold tracking-tight text-fd-foreground">
            Build, deploy, and manage updates
          </h2>
          <p className="mt-3 sm:mt-4 text-base sm:text-lg text-fd-muted-foreground">
            Control OTA delivery from your own infrastructure
          </p>
        </div>

        {/* Features grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6 lg:gap-8">
          {features.map((feature) => (
            <div
              key={feature.title}
              className="group relative rounded-lg border border-fd-border bg-fd-card/50 p-5 sm:p-6 transition-all hover:border-fd-border/70 hover:bg-fd-accent/50"
            >
              {/* Icon */}
              <div className="mb-3 sm:mb-4 text-2xl sm:text-3xl">
                {feature.icon}
              </div>

              {/* Title */}
              <h3 className="text-base sm:text-lg font-semibold text-fd-foreground mb-2">
                {feature.title}
              </h3>

              {/* Description */}
              <p className="text-sm text-fd-muted-foreground leading-relaxed">
                {feature.description}
              </p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

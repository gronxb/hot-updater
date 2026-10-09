# Hot Updater Console

Modern web-based management console for Hot Updater built with **TanStack Start** and **shadcn/ui**.

## 🚀 Features

- **Bundle Management** - View, filter, and manage OTA update bundles
- **Real-time Filtering** - Filter by platform (iOS/Android) and channel
- **Release Editor** - Edit delivery policy, rollout, and target cohorts
- **Rollout Control** - Adjust rollout percentage with visual slider
- **Rollout Statistics** - View deployment metrics and success rates
- **Channel Promotion** - Copy or move releases between channels
- **Rollback** - Disable a release and save; devices reconsider it on their next update check
- **Dark Mode** - Full dark mode support with system preference detection
- **Responsive Design** - Works seamlessly on desktop, tablet, and mobile

## 🛠️ Tech Stack

### Frontend

- **TanStack Start** - Full-stack React framework with SSR
- **TanStack Router** - File-based routing with type safety
- **TanStack Query** - Data fetching and caching
- **React 19** - Latest React features

### UI Components

- **shadcn/ui** - High-quality accessible components built on Base UI
- **Tailwind CSS v4** - Utility-first CSS with oklch color system
- **Lucide React** - Beautiful icon library
- **Sonner** - Toast notifications

### Backend

- **TanStack Start Server Functions** - Type-safe server endpoints
- **Hot Updater Integration** - Storage and database adapter integration

## 📦 Installation

```bash
# Install and build workspace dependencies (from monorepo root)
pnpm install
pnpm -w build
```

## 🏃‍♂️ Development

```bash
# Run these commands from the monorepo root
# Start the local development server
pnpm --dir packages/console dev

# Build and preview the local console package
pnpm --dir packages/console build
pnpm --dir packages/console preview

# Type checking
pnpm --dir packages/console test:type
```

The development server is available at `http://localhost:3000`.

This package's Vite configuration uses the local console adapter, which grants
management access without sign-in in both development and built output. Keep
this build and preview local. For production hosting, follow the
[Console deployment guide](https://hot-updater.dev/docs/guides/console-deployment)
and configure its hosted template with a `ConsoleAuthAdapter`.

## 📁 Project Structure

```
src/
├── routes/
│   ├── __root.tsx              # Root layout with providers
│   ├── index.tsx               # Bundle/release list page
│   ├── -releases-search.ts     # URL filter validation
│   └── api/                    # Authentication and bundle downloads
├── components/
│   ├── ui/                     # shadcn components
│   ├── features/
│   │   ├── bundles/            # Bundle metadata and rollout details
│   │   └── releases/           # Release policy editor
│   ├── PlatformIcon.tsx        # iOS/Android icons
│   ├── BundleIdDisplay.tsx     # Truncated bundle ID with tooltip
│   ├── RolloutPercentageBadge.tsx
│   ├── TimestampDisplay.tsx    # UUIDv7 timestamp formatting
│   ├── ChannelBadge.tsx
│   └── EnabledStatusIcon.tsx
├── lib/
│   ├── api.ts                  # React Query hooks
│   ├── api-rpc.ts              # TanStack Start server functions
│   ├── constants.ts            # Shared constants
│   ├── utils.ts                # Utility functions
│   └── server/
│       ├── auth.server.ts      # Management access checks
│       └── config.server.ts    # Hot Updater config loader
└── styles.css                  # Global styles & theme variables
```

## 🎨 Key Components

### Bundle List Page

- **BundlesPage** - Release-backed list with server-side pagination (20 per page)
- **BundleFilterToolbar** - Platform, channel, and enabled-state filters
- Both live in `src/routes/index.tsx`.

### Release Editor Sheet

- **ReleaseEditorSheet** - Slide-out editor for release policy, rollout, and promotion
- **BundleMetadata** - Read-only bundle information display
- Saving preflights the policy, then updates it with the expected release revision.
- To roll back a release, turn off **Enabled** and select **Save changes**.
  On the next update check, devices select a previous eligible release or the
  built-in app when none remains; the app still controls applying the result.

### Dialogs

- **ReleaseEditorSheet** contains promotion and release-deletion dialogs.
- **RolloutCohortsDialog** displays rollout and targeted cohorts.
- **ChannelManagementDialog** creates and deletes channels.

## 🔌 API Integration

The console integrates with the configured Hot Updater storage and database
adapters through TanStack Start server functions in `src/lib/api-rpc.ts`.
Functions with input take a `{ data: input }` argument:

- `getConfig()` and `getChannels()` load configuration and channels.
- `getReleases({ data: { filter, limit, beforeReleaseId, afterReleaseId } })`
  lists releases using the supported `ReleaseFilter` shapes.
- `getRelease({ data: { releaseId } })` reads a release.
- `preflightRelease({ data: { releaseId, expectedRevision, patch } })` validates
  a `ReleasePolicyPatch`; `updateRelease` takes the same input to save it.
- `deleteRelease({ data: { releaseId, expectedRevision } })` deletes a release.
- `promoteRelease({ data: { releaseId, expectedRevision, targetChannel, action } })`
  copies or moves a release; `action` is `"copy"` or `"move"`.
- `getBundles({ data: { platform, limit, after, before } })` lists bundle artifacts;
  `getBundle({ data: { bundleId } })` reads one and
  `deleteBundle({ data: { bundleId } })` deletes one.

Use one pagination cursor at a time.

## 🎯 Configuration

The console reads `database`, `storage`, and `plugins` from
[hot-updater.config.ts](hot-updater.config.ts), as the CLI does, and runs the
plugins over the database as the server does. The checked-in
[demo database](demoDatabase.ts) seeds sample bundles, releases, and Insights
events through `assembleServer` from `@hot-updater/cli-tools`, over
`database.withoutLatency()`. For an empty local mock console, use this
`hot-updater.config.ts`:

```typescript
import { mockDatabase, mockStorage } from "@hot-updater/mock";

export default {
  database: mockDatabase({ latency: { min: 500, max: 700 } }),
  storage: mockStorage({}),
};
```

Import the built-in factories from `hot-updater/plugins` and add `plugins`,
such as `[insights(), apiKeys()]`, to show their pages. Mock data is held in
memory and resets when the configuration is reloaded.

## 🌈 Theming

The console uses Tailwind CSS v4 with oklch color space for accessible colors. Theme variables are defined in `src/styles.css`:

- Light mode: Default
- Dark mode: Automatically enabled with `class="dark"`
- System preference: Respects OS theme setting

## 🔒 Type Safety

- Full TypeScript strict mode
- Type-safe server functions with TanStack Start
- Type-safe routing with TanStack Router
- Typed release-policy drafts and revision-aware mutations

## 📊 Data Flow

1. **URL State** → `Route.useSearch()` and `-releases-search.ts` manage release filters
2. **Server Functions** → TanStack Start server functions call the configured storage and database adapters
3. **React Query** → `useReleasesQuery()` and `useBundleQuery()` fetch and cache data
4. **UI Components** → Display data with shadcn components
5. **Mutations** → `usePreflightReleaseMutation()` validates changes before `useUpdateReleaseMutation()` saves them
6. **Cache Invalidation** → Successful updates invalidate release, catalog, and channel queries

## 🚦 Development Guidelines

- **Server-only code** must use `.server.ts` extension
- **Client-side constants** live in `src/lib/constants.ts`
- **shadcn components** are customizable in `src/components/ui/`
- **Release validation** checks the draft locally and preflights changes on the server
- **Toast notifications** use Sonner for success/error feedback

## 🐛 Troubleshooting

### Build Errors

- Ensure `.server.ts` files are not imported on the client
- Check that native modules (`.node`) are excluded from bundling

### Development Server

- Default port is 3000
- Change port: `pnpm --dir packages/console dev --port 3001`

### Hot Updater Config

- Ensure `hot-updater.config.ts` is at the package root and sets `database`
  and `storage`
- Verify its storage and database adapters are correctly initialized

## 📝 License

MIT - See monorepo LICENSE file

## 🤝 Contributing

See the main Hot Updater repository for contribution guidelines.

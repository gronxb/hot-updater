# Hot Updater Console (v2)

Modern web-based management console for Hot Updater built with **TanStack Start** and **shadcn/ui**.

## 🚀 Features

- **Bundle Management** - View, filter, and manage OTA update bundles
- **Real-time Filtering** - Filter by platform (iOS/Android) and channel
- **Bundle Editor** - Edit bundle configurations with intuitive forms
- **Rollout Control** - Adjust rollout percentage with visual slider
- **Rollout Statistics** - View deployment metrics and success rates
- **Channel Promotion** - Copy or move bundles between channels
- **Emergency Rollback** - One-click disable and rollback
- **Dark Mode** - Full dark mode support with system preference detection
- **Responsive Design** - Works seamlessly on desktop, tablet, and mobile

## 🛠️ Tech Stack

### Frontend
- **TanStack Start** - Full-stack React framework with SSR
- **TanStack Router** - File-based routing with type safety
- **TanStack Query** - Data fetching and caching
- **TanStack Form** - Form state management and validation
- **TanStack Table** - Powerful table with sorting and pagination
- **React 19** - Latest React features

### UI Components
- **shadcn/ui** - High-quality accessible components (Radix Mira style)
- **Tailwind CSS v4** - Utility-first CSS with oklch color system
- **Lucide React** - Beautiful icon library
- **Sonner** - Toast notifications

### Backend
- **TanStack Start Server Functions** - Type-safe server endpoints
- **Hot Updater Plugins** - Storage and database plugin integration

## 📦 Installation

```bash
# Install dependencies (from monorepo root)
pnpm install
```

## 🏃‍♂️ Development

```bash
# Start development server
pnpm dev

# Build for production
pnpm build

# Preview production build
pnpm preview

# Type checking
pnpm test:type
```

The console will be available at `http://localhost:3000`.

## 📁 Project Structure

```
src/
├── routes/
│   ├── __root.tsx              # Root layout with providers
│   ├── index.tsx               # Bundle list page
│   └── api/                    # API routes (future)
├── components/
│   ├── ui/                     # shadcn components
│   ├── features/
│   │   └── bundles/            # Bundle-related components
│   ├── PlatformIcon.tsx        # iOS/Android icons
│   ├── BundleIdDisplay.tsx     # Truncated bundle ID with tooltip
│   ├── RolloutPercentageBadge.tsx
│   ├── TimestampDisplay.tsx    # UUIDv7 timestamp formatting
│   ├── ChannelBadge.tsx
│   └── EnabledStatusIcon.tsx
├── hooks/
│   └── useFilterParams.ts      # URL-based filter state
├── lib/
│   ├── api.ts                  # React Query hooks
│   ├── constants.ts            # Shared constants
│   ├── utils.ts                # Utility functions
│   └── server/
│       ├── api.server.ts       # Server functions
│       └── config.server.ts    # Hot Updater config loader
└── styles.css                  # Global styles & theme variables
```

## 🎨 Key Components

### Bundle List Page
- **FilterToolbar** - Platform and channel filters with reset button
- **BundlesTable** - Server-side paginated table (20 per page)
- **BundleTableColumns** - Column definitions with custom cell renderers

### Bundle Editor Sheet
- **BundleEditorSheet** - Right-side slide-out panel
- **BundleEditorForm** - TanStack Form with validation
- **BundleMetadata** - Read-only bundle information display

### Dialogs
- **PromoteChannelDialog** - Channel promotion with copy/move toggle
- **DeleteBundleDialog** - Confirmation dialog with bundle details
- **EmergencyRollbackButton** - One-click disable + 0% rollout

## 🔌 API Integration

The console integrates with Hot Updater's plugin system through TanStack Start server functions:

- `getConfig()` - Load console configuration
- `getChannels()` - List available channels
- `getBundles(filters)` - List bundles with pagination
- `getBundle(bundleId)` - Get single bundle details
- `updateBundle(bundleId, data)` - Update bundle configuration
- `createBundle(bundle)` - Create new bundle
- `deleteBundle(bundleId)` - Delete bundle

## 🎯 Configuration

Configure Hot Updater in `hot-updater.config.ts`:

```typescript
import { mockDatabase, mockStorage } from "@hot-updater/mock";

export default {
  storage: mockStorage(),
  database: mockDatabase({
    latency: { min: 500, max: 700 },
    initialBundles: [
      // ... your bundles
    ],
  }),
};
```

## 🌈 Theming

The console uses Tailwind CSS v4 with oklch color space for accessible colors. Theme variables are defined in `src/styles.css`:

- Light mode: Default
- Dark mode: Automatically enabled with `class="dark"`
- System preference: Respects OS theme setting

## 🔒 Type Safety

- Full TypeScript strict mode
- Type-safe server functions with TanStack Start
- Type-safe routing with TanStack Router
- Type-safe forms with TanStack Form

## 📊 Data Flow

1. **URL State** → `useFilterParams()` hook manages filter state in URL
2. **Server Functions** → TanStack Start server functions call Hot Updater plugins
3. **React Query** → `useBundlesQuery()` fetches and caches data
4. **UI Components** → Display data with shadcn components
5. **Mutations** → `useUpdateBundleMutation()` updates data with optimistic updates
6. **Cache Invalidation** → React Query automatically refreshes affected queries

## 🚦 Development Guidelines

- **Server-only code** must use `.server.ts` extension
- **Client-side constants** live in `src/lib/constants.ts`
- **shadcn components** are customizable in `src/components/ui/`
- **Form validation** uses TanStack Form validators
- **Toast notifications** use Sonner for success/error feedback

## 🐛 Troubleshooting

### Build Errors
- Ensure `.server.ts` files are not imported on the client
- Check that native modules (`.node`) are excluded from bundling

### Development Server
- Default port is 3000
- Change port: `pnpm dev --port 3001`

### Hot Updater Config
- Ensure `hot-updater.config.ts` is at package root
- Verify storage and database plugins are correctly initialized

## 📝 License

MIT - See monorepo LICENSE file

## 🤝 Contributing

See the main Hot Updater repository for contribution guidelines.

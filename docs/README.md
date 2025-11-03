# Hot Updater Documentation

This documentation site is built with [TanStack Start](https://tanstack.com/start) and [Fumadocs](https://fumadocs.dev).

## Development

```bash
pnpm install
pnpm dev
```

## Build

```bash
pnpm build
```

## Project Structure

- `app/` - TanStack Start application code
  - `routes/` - Application routes
    - `__root.tsx` - Root layout with RootProvider
    - `index.tsx` - Landing page
    - `docs.tsx` - Documentation layout
    - `docs.$.tsx` - Dynamic documentation pages
    - `api/search.ts` - Search API endpoint
  - `lib/` - Shared utilities
    - `source.ts` - Fumadocs content loader
    - `layout.shared.tsx` - Shared layout configuration
  - `styles/` - Global styles (Tailwind CSS 4)
- `content/docs/` - MDX documentation files
- `public/` - Static assets

## Configuration Files

- `app.config.ts` - TanStack Start configuration with Fumadocs MDX plugin
- `source.config.ts` - Fumadocs content configuration
- `tsconfig.json` - TypeScript configuration

## Current Status

The project structure is set up and ready for content migration from the previous RSPress setup.

### Known Issues

- There is currently a version compatibility issue between @tanstack/start-config and @tanstack/router-generator that needs to be resolved
- This is being tracked and will be fixed in an upcoming update

## Next Steps

1. Resolve the TanStack Start version compatibility issue
2. Migrate existing documentation content from `docs/docs/` to `content/docs/`
3. Create a custom landing page
4. Update deployment configuration for Cloudflare Pages

## Homepage

https://hot-updater.dev/

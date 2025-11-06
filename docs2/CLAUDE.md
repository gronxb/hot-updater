# CLAUDE.md - Documentation Guidelines

This file provides guidance to Claude Code when working with documentation in the `docs2` directory.

## Documentation Structure

The docs2 directory uses Fumadocs (a modern documentation framework) with the following structure:

```
docs2/
├── content/
│   └── docs/
│       ├── build-plugins/      # Build plugin documentation
│       ├── storage-plugins/    # Storage plugin documentation
│       ├── database-plugins/   # Database plugin documentation
│       └── integration-plugins/ # Integration plugin documentation
├── src/                        # Documentation site source
├── public/                     # Static assets
└── waku.config.ts             # Waku configuration
```

## Documentation Standards

### File Format
- Use `.mdx` format for all documentation files
- Include frontmatter with `title`, `description`, and `icon`
- Use kebab-case for file names (e.g., `aws.mdx`, `supabase.mdx`)

### Frontmatter Template
```mdx
---
title: "Plugin Name"
description: Brief description of the plugin
icon: icon-name
---
```

### Package Installation
**IMPORTANT**: Use `package-install` code block syntax with full npm command:

```package-install
npm install @hot-updater/plugin-name --save-dev
```

**NOT** these:
```bash
npm install @hot-updater/plugin-name
```

All Hot Updater plugins should be installed as dev dependencies (`--save-dev`).

### Documentation Structure

Each plugin documentation should follow this structure:

1. **Title & Overview** (H1)
   - Brief 1-2 sentence description of what the plugin does

2. **Installation** (H2)
   - Use `package-install` code block

3. **Configuration** (H2)
   - TypeScript interface showing all config options
   - Include inline comments for each field

4. **Usage** (H2)
   - Complete working example with `defineConfig`
   - Show environment variable usage

5. **Setup** (H2) - Optional
   - Provider-specific setup steps (minimal)
   - Keep it concise

6. **Key Features** (H2)
   - 3-5 bullet points of main capabilities

7. **Environment Variables** (H2)
   - Example .env format
   - Use placeholder values

8. **Complete Example** (H2) - Optional
   - Show combined storage + database when applicable

## Code Block Guidelines

### TypeScript Configuration
```typescript
interface PluginConfig {
  field: string;  // Brief inline comment
}
```

### Usage Examples
- Always use `process.env.VARIABLE_NAME` for sensitive data
- Include `defineConfig` wrapper
- Show full imports

### Environment Variables
```bash
VARIABLE_NAME=value
```

## Writing Style

- **Concise**: Keep descriptions brief and to the point
- **Usage-focused**: Prioritize practical examples over theory
- **No emojis**: Unless explicitly requested by user
- **English only**: All documentation in English
- **Minimal setup**: Quick start approach, avoid excessive detail

## Plugin Types

### Build Plugins
Located in `content/docs/build-plugins/`
- bare.mdx - React Native CLI
- expo.mdx - Expo projects
- rock.mdx - Rock bundler

### Storage Plugins
Located in `content/docs/storage-plugins/`
- supabase.mdx - Supabase Storage
- aws.mdx - AWS S3 (also covers Cloudflare R2)
- cloudflare.mdx - Cloudflare R2 via Wrangler
- firebase.mdx - Firebase Cloud Storage
- standalone.mdx - Custom self-hosted storage

### Database Plugins
Located in `content/docs/database-plugins/`
- supabase.mdx - Supabase PostgreSQL
- aws.mdx - S3 + CloudFront JSON storage
- cloudflare.mdx - Cloudflare D1
- firestore.mdx - Firebase Firestore
- standalone.mdx - Custom self-hosted database

## Common Patterns

### When documenting plugins that work together:
Include a "Complete Example" section showing both storage and database combined.

### When documenting alternatives:
If one plugin has limitations (e.g., Cloudflare R2 storage), recommend the better alternative upfront with a warning box:

```mdx
> **⚠️ Recommendation**: Use alternative plugin instead...
```

### When documenting peer dependencies:
Show both in installation and include a separate Dependencies section at the end.

## Commands

### Build documentation site
```bash
cd docs2
pnpm install
pnpm dev
```

### Build for production
```bash
pnpm build
```

## Notes for Claude

- Always use `package-install` code blocks for package installation
- Keep documentation minimal and usage-focused
- Don't add verbose setup instructions unless necessary
- Use TypeScript interfaces to show configuration options
- Include environment variable examples
- Show complete working examples with imports
- Keep consistent structure across all plugin docs

# CLAUDE.md - Documentation Guidelines

This file provides guidance to Claude Code when working with documentation in the `docs` directory.

## Documentation Structure

The docs directory uses Fumadocs (a modern documentation framework) with the following structure:

```
docs/
├── content/
│   └── docs/
│       ├── get-started/        # Getting started guides
│       ├── managed-hosting/    # Managed cloud provider guides (Supabase, Firebase, Cloudflare, AWS)
│       ├── self-hosting/       # Self-hosting server setup guides
│       ├── build-plugins/      # Build plugin documentation
│       ├── storage-plugins/    # Storage plugin documentation
│       ├── database-plugins/   # Database plugin documentation
│       ├── react-native-api/   # Client-side API reference
│       ├── guides/             # Advanced topics and guides
│       ├── cli-reference/      # CLI command documentation
│       └── policy/             # Security and best practices
├── src/                        # Documentation site source
├── public/                     # Static assets
└── waku.config.ts             # Waku configuration
```

## Sidebar Configuration (meta.json)

**IMPORTANT**: Every documentation section MUST have a `meta.json` file to appear in the sidebar.

### meta.json Structure

Each directory with documentation pages needs a `meta.json` file:

```json
{
  "title": "Section Title",
  "description": "Brief description of the section",
  "icon": "IconName",
  "pages": ["page1", "page2", "page3"]
}
```

### meta.json Rules

- **File references**: List page filenames WITHOUT the `.mdx` extension
- **Page order**: Pages appear in the sidebar in the array order
- **Icon names**: Use Lucide icon names (e.g., "Server", "Database", "Hammer", "Plug")
- **Required fields**: All fields (title, description, icon, pages) are required

### Examples

**Plugin section** (`content/docs/storage-plugins/meta.json`):
```json
{
  "title": "Storage Plugins",
  "description": "Storage provider plugins",
  "icon": "Database",
  "pages": ["supabase", "cloudflare", "firebase", "aws"]
}
```

**Multi-page section** (`content/docs/self-hosting/meta.json`):
```json
{
  "title": "Self-Hosting",
  "description": "Self-hosting server setup",
  "icon": "Server",
  "pages": [
    "overview",
    "quick-start",
    "cli-configuration"
  ]
}
```

### When to Update meta.json

- When adding new documentation pages
- When removing documentation pages
- When reordering pages in the sidebar
- When changing section metadata

**Remember**: If a page is not listed in `pages` array, it won't appear in the sidebar!

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

**Frontmatter Description Rules:**
- **Keep it concise**: 1 sentence maximum, ideally under 20 words
- **High-level overview**: Don't include technical details or implementation specifics
- **No links**: Save links for the body content
- **Action-oriented**: Focus on what it does or what problem it solves

**Body Structure Rules:**
- **Start with ## heading**: Body content must begin directly with a `##` heading (no text between frontmatter and first heading)
- **No duplicate descriptions**: Don't repeat the frontmatter description as the first paragraph
- **Natural flow**: Content should flow logically from one section to the next

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

**Important**: Body content starts directly with `##` heading. No text or H1 between frontmatter and first `##`.

1. **Installation** (H2)
   - Use `package-install` code block

2. **Configuration** (H2)
   - TypeScript interface showing all config options
   - Include inline comments for each field

3. **Usage** (H2)
   - Complete working example with `defineConfig`
   - Show environment variable usage

4. **Setup** (H2) - Optional
   - Provider-specific setup steps (minimal)
   - Keep it concise

5. **Key Features** (H2)
   - 3-5 bullet points of main capabilities

6. **Complete Example** (H2) - Optional
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

### Readability Guidelines

- **Short sentences**: Target 15-25 words per sentence. Break sentences over 30 words into multiple sentences
- **Natural flow**: Write like water flows - smooth transitions between sections, no abrupt jumps
- **Active voice**: Use direct, active language (e.g., "Configure your app" not "Your app needs to be configured")
- **Avoid verbosity**: Remove redundant explanations, unnecessary introductions, and filler words
- **Progressive disclosure**: Start with simple concepts, progress to advanced topics
- **Scannable content**: Use headings, bullet points, and code examples to break up text
- **Clear hierarchy**: Organize sections logically (Overview → Setup → Usage → Advanced)

## Documentation Sections

### Managed Hosting
Located in `content/docs/managed-hosting/`
- supabase.mdx - Supabase setup guide
- firebase.mdx - Firebase setup guide
- cloudflare.mdx - Cloudflare setup guide
- aws.mdx - AWS setup guide

### Self-Hosting
Located in `content/docs/self-hosting/`
- overview.mdx - Self-hosting architecture overview
- quick-start.mdx - Quick start guide
- cli-configuration.mdx - CLI configuration
- database/ - Database adapter guides (Drizzle, Prisma, Kysely, MongoDB)
- frameworks/ - Server framework guides (Hono, Express, Elysia)
- hosting/ - Deployment platform guides (Docker, Cloudflare Workers, Vercel)

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
cd docs
pnpm install
pnpm dev
```

### Build for production
```bash
pnpm build
```

## 404 Page Guidelines

### Global 404 Page
Located at `src/pages/404.tsx` - handles all unmatched routes.

**Structure:**
- Uses HomeLayout for consistent navigation and branding
- Center-aligned content with proper spacing
- Includes "Go Back Home" link
- Theme-aware colors (dark/light mode support)

**When to modify:**
- Update styling to match site theme changes
- Add custom error tracking if needed
- Maintain consistent branding with other pages

### Inline 404 Handler
Located in `src/pages/docs/[...slugs].tsx:14-24` - handles missing documentation pages.

**Purpose:**
- Shows 404 within docs layout when a doc page doesn't exist
- Preserves sidebar and navigation for better UX
- Different from global 404 (no layout redirect needed)

**Key differences:**
- **Global 404**: Unmatched routes (e.g., `/random`) → Full layout with navigation
- **Inline 404**: Missing docs (e.g., `/docs/invalid`) → Shows within docs layout

## Documentation URL Patterns

When referencing documentation in code, comments, or other docs, use these patterns:

- **Managed hosting**: `/docs/managed-hosting/{provider}` (e.g., `/docs/managed-hosting/supabase`)
- **Self-hosting**: `/docs/self-hosting/{topic}` (e.g., `/docs/self-hosting/quick-start`)
- **Database adapters**: `/docs/self-hosting/database/{adapter}` (e.g., `/docs/self-hosting/database/drizzle`)
- **Server frameworks**: `/docs/self-hosting/frameworks/{framework}` (e.g., `/docs/self-hosting/frameworks/hono`)
- **Hosting platforms**: `/docs/self-hosting/hosting/{platform}` (e.g., `/docs/self-hosting/hosting/docker`)
- **Storage plugins**: `/docs/storage-plugins/{provider}` (e.g., `/docs/storage-plugins/aws`)
- **Database plugins**: `/docs/database-plugins/{provider}` (e.g., `/docs/database-plugins/cloudflare`)
- **Build plugins**: `/docs/build-plugins/{bundler}` (e.g., `/docs/build-plugins/expo`)
- **React Native API**: `/docs/react-native-api/{topic}` (e.g., `/docs/react-native-api/wrap`)
- **Guides**: `/docs/guides/{topic}` (e.g., `/docs/guides/update-strategies`)

## Notes for Claude

- Always use `package-install` code blocks for package installation
- **Frontmatter description**: 1 concise sentence, max 20 words, no links
- **Body structure**: Start directly with `##` heading, no text before it
- Keep documentation minimal and usage-focused
- Write short sentences (15-25 words), break long sentences (30+ words)
- Use active voice and direct language
- Don't add verbose setup instructions unless necessary
- Remove redundant explanations and introductions
- Use TypeScript interfaces to show configuration options
- Show complete working examples with imports
- Keep consistent structure across all plugin docs
- Organize content logically: Overview → Setup → Usage → Advanced
- **Important**: Documentation folder names are `managed-hosting` (not managed-providers) and `self-hosting` (not self-hosted)

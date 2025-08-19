# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Hot Updater is a self-hostable OTA (Over-The-Air) update solution for React Native apps, serving as an alternative to CodePush. It consists of a monorepo with packages and plugins organized using NX workspace management.

## Key Architecture

### Plugin System
The system is built around three plugin types:
- **Build Plugins**: Handle bundling (Metro, Re.Pack, Expo) - located in `plugins/expo/`, `plugins/bare/`, `plugins/repack/`, `plugins/rock/`
- **Storage Plugins**: Handle bundle storage (AWS S3, Cloudflare R2, Supabase Storage, Firebase Storage) - located in `plugins/aws/`, `plugins/cloudflare/`, `plugins/supabase/`, `plugins/firebase/`, `plugins/standalone/`
- **Database Plugins**: Handle metadata storage (PostgreSQL, Cloudflare D1, Supabase Database) - uses same plugin directories as storage

### Core Packages
- `packages/core/`: Core types and utilities
- `packages/hot-updater/`: CLI tool and main commands
- `packages/react-native/`: React Native library for client-side integration
- `packages/console/`: Web-based management console built with Solid/Vite

### Configuration
Projects use `hot-updater.config.ts` files that define build, storage, and database plugins using the `defineConfig()` function.

## Common Commands

### Development
```bash
# Install dependencies
pnpm install

# Build all packages and plugins
pnpm build

# Build in watch mode for development
pnpm build:dev

# Run tests
pnpm test

# Type checking
pnpm test:type

# Format code with Biome
pnpm biome

# Check code with Biome
pnpm biome:check
```

### Release Management
```bash
# Test release (dry run)
pnpm release:test

# Create release (without publishing)
pnpm release

# Publish all packages
pnpm publish:all

# Publish release candidate
pnpm publish:rc
```

### Hot Updater CLI
```bash
# Initialize hot updater in a project
npx hot-updater init

# Deploy bundle
npx hot-updater deploy

# Open web console
npx hot-updater console

# Check project health
npx hot-updater doctor

# Generate fingerprint
npx hot-updater fingerprint

# Manage channels
npx hot-updater channel
```

## Development Notes

### Code Style
- Uses Biome for formatting and linting (see `biome.json`)
- 2-space indentation, 80 character line width
- Semicolons required, arrow parentheses always

### Testing
- Uses Vitest with workspace configuration
- Cloudflare Workers testing uses `@cloudflare/vitest-pool-workers`
- Each plugin/package has its own test configuration

### Build System
- NX workspace with shared build targets
- TypeScript compilation with `tsdown`
- Outputs go to `dist/` directories

### Project Structure
- Monorepo with `packages/` (core functionality) and `plugins/` (provider integrations)
- Examples in `examples/` showing different React Native versions and configurations
- Documentation site in `docs/` using RSPress

### Native Modules
The React Native package includes native iOS (Swift) and Android (Kotlin) implementations with support for both old and new React Native architectures.
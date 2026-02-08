# Hot Updater Console Migration Plan
## Solid.js → TanStack Start + shadcn/ui

---

## 📋 Plan Summary

### Technology Stack Decisions
- ✅ **Backend**: TanStack Start API routes (migrating from Hono RPC)
- ✅ **Forms**: TanStack Form
- ✅ **Toasts**: Sonner
- ✅ **UI Framework**: shadcn/ui (Radix Mira style)
- ✅ **Data Fetching**: TanStack Query (React Query)
- ✅ **Router**: TanStack Router (file-based routing)
- ✅ **Styling**: Tailwind CSS v4 with oklch color system

### Migration Scope
**8 Migration Phases:**
1. **Backend Migration** - Convert 9 Hono RPC endpoints to TanStack Start server functions
2. **Data Layer** - Set up React Query hooks (5 queries, 3 mutations)
3. **UI Components** - Add 8 shadcn components + build 6 custom display components
4. **Feature Implementation** - Migrate bundle table, editor sheet, and 4 dialogs
5. **Hooks & State** - Create 3 custom hooks for filters, forms, and state management
6. **Configuration** - Port hot-updater.config.ts and install dependencies
7. **Testing & Validation** - Test 18 features + verify CI/CD passes
8. **Cleanup** - Remove demo content, update documentation

### Key Features to Migrate (100% Feature Parity)
- ✅ Bundle management table with server-side pagination (20 per page)
- ✅ Platform filter (All, iOS, Android) + dynamic channel filter
- ✅ Bundle editor sheet with 7 form fields
- ✅ Rollout statistics dialog
- ✅ Promote channel dialog (copy/move operations)
- ✅ Emergency rollback button (one-click disable + 0% rollout)
- ✅ Delete bundle confirmation

### File Structure Changes
**Source:** `packages/console/` (Solid.js + Hono)
**Target:** `packages/console2/` (TanStack Start + React)

**New Structure:**
```
packages/console2/src/
├── routes/
│   ├── api/                    # TanStack Start server functions (9 endpoints)
│   │   ├── config.ts
│   │   ├── channels.ts
│   │   └── bundles/
│   ├── index.tsx               # Bundle list page
│   └── __root.tsx
├── components/
│   ├── ui/                     # 14+ shadcn components
│   └── features/bundles/       # 9 feature components
├── hooks/                      # 3 custom hooks
└── lib/                        # API client + utilities
```

### Dependencies to Add
```bash
pnpm add @hot-updater/core hono typia dayjs sonner @tanstack/react-form
```

### Success Criteria
- ✅ All 18 console features working
- ✅ TypeScript strict mode, no errors
- ✅ CI/CD passing (build, lint, test, type-check)
- ✅ Dark mode fully functional
- ✅ Responsive design (mobile/tablet/desktop)
- ✅ Accessible (WCAG 2.1 AA)
- ✅ Performance (< 2s initial load, < 500ms navigation)

---

## Overview

Migrate `packages/console/` to `packages/console2/` by transitioning from Solid.js to TanStack Start (React) while maintaining all existing functionality and redesigning the UI to follow shadcn design principles.

### Goals
- ✅ Preserve all Hot Updater console features
- ✅ Modernize tech stack to TanStack Start ecosystem
- ✅ Implement shadcn/ui design system
- ✅ Improve maintainability and developer experience
- ✅ Maintain backend compatibility with existing Hot Updater plugins

---

## Current State Analysis

### packages/console/ (Source)
**Tech Stack:**
- Solid.js + @solidjs/router
- Hono backend (RPC endpoints)
- TanStack Solid Query/Form/Table
- Kobalte (headless UI)
- Tailwind CSS

**Features:**
1. Bundle management table with pagination
2. Platform/channel filtering
3. Bundle editor sheet (enable, force update, rollout %, target devices)
4. Rollout statistics dialog
5. Promote/migrate bundles between channels
6. Emergency rollback button
7. Delete bundle confirmation
8. UUIDv7 timestamp extraction utilities

### packages/console2/ (Target)
**Tech Stack:**
- TanStack Start + TanStack Router
- React 19 + SSR with Nitro
- TanStack Query (React Query)
- shadcn/ui (Radix Mira style)
- Tailwind CSS v4

**Status:**
- ✅ Foundation ready (routing, UI components, theming)
- ❌ No Hot Updater features implemented yet
- ✅ 14 shadcn components available
- ✅ Dark mode support with oklch color system

---

## Migration Strategy

### Phase 1: Backend Migration
Migrate the Hono backend from `packages/console/src-server/` to `packages/console2/`.

#### Tasks:
1. **Set up Hono backend in console2**
   - Create `src-server/` directory structure
   - Port `src-server/index.ts` (Hono app setup)
   - Port `src-server/rpc.ts` (RPC endpoints)
   - Adapt for TanStack Start's Nitro backend

2. **Configure build pipeline**
   - Update `vite.config.ts` to serve Hono routes
   - Set up `tsdown.config.ts` for server builds
   - Configure static asset serving

3. **Test RPC endpoints**
   - Verify all 9 endpoints work:
     - `GET /rpc/config`
     - `GET /rpc/channels`
     - `GET /rpc/config-loaded`
     - `GET /rpc/bundles` (with filters/pagination)
     - `GET /rpc/bundles/:bundleId`
     - `GET /rpc/bundles/:bundleId/rollout-stats`
     - `PATCH /rpc/bundles/:bundleId`
     - `POST /rpc/bundles`
     - `DELETE /rpc/bundles/:bundleId`

**Critical Files:**
- `packages/console/src-server/index.ts`
- `packages/console/src-server/rpc.ts`
- `packages/console/vite.config.ts`
- `packages/console/tsdown.config.ts`

---

### Phase 2: Data Layer Migration
Set up TanStack Query hooks and utilities for data fetching.

#### Tasks:
1. **Create API client**
   - Port `src/lib/api.ts` from Solid Query to React Query
   - Update Hono client for React
   - Create query hooks:
     - `useConfigQuery()` - Load console configuration
     - `useChannelsQuery()` - List channels
     - `useBundlesQuery(filters)` - List bundles with pagination
     - `useBundleQuery(bundleId)` - Get single bundle
     - `useRolloutStatsQuery(bundleId)` - Get rollout stats
   - Create mutation hooks:
     - `useUpdateBundleMutation()` - Update bundle
     - `useCreateBundleMutation()` - Create bundle
     - `useDeleteBundleMutation()` - Delete bundle

2. **Create utilities**
   - Port `src/lib/extract-timestamp-from-uuidv7.ts` (unchanged)
   - Port `src/lib/utils.ts` (merge with existing)

3. **Set up query caching strategy**
   - Configure infinite stale time for bundles/config
   - Set up cache invalidation on mutations
   - Add placeholder data for smooth transitions

**Critical Files:**
- `packages/console/src/lib/api.ts`
- `packages/console/src/lib/extract-timestamp-from-uuidv7.ts`

---

### Phase 3: UI Component Development
Build shadcn-based components matching current console features.

#### Tasks:
1. **Add missing shadcn components**
   - Sheet (side panel for bundle editor)
   - Dialog (confirmations, stats viewer)
   - Switch (enable/disable toggles)
   - Slider (rollout percentage)
   - Tooltip (bundle ID truncation)
   - Skeleton (loading states)
   - Toast/Sonner (notifications)
   - Pagination (already exists, verify compatibility)
   - Table (already exists, adapt for bundles)
   - Combobox (already exists, use for channel filter)

2. **Build custom components**
   - `PlatformIcon.tsx` - iOS/Android icon display
   - `BundleIdDisplay.tsx` - Truncated ID with tooltip
   - `RolloutPercentageBadge.tsx` - Warning for < 100%
   - `TimestampDisplay.tsx` - Formatted date from UUIDv7
   - `ChannelBadge.tsx` - Channel name display
   - `EnabledStatusIcon.tsx` - Check/X icon display

3. **Design system consistency**
   - Use shadcn's stone base color
   - Apply oklch color system for accessibility
   - Implement responsive layouts
   - Add dark mode support to all components
   - Follow Radix Mira style guidelines

**shadcn Components to Add:**
```bash
npx shadcn@latest add sheet
npx shadcn@latest add dialog
npx shadcn@latest add switch
npx shadcn@latest add slider
npx shadcn@latest add tooltip
npx shadcn@latest add skeleton
npx shadcn@latest add toast
npx shadcn@latest add table  # verify/update existing
```

---

### Phase 4: Feature Implementation
Implement all console features with new React components.

#### 4.1 Bundle List Page (`src/routes/index.tsx`)
**Layout:**
- Header with filter controls (platform, channel)
- Data table with columns:
  - Bundle ID (truncated with tooltip)
  - Channel (badge)
  - Platform (icon)
  - Target (app version or fingerprint hash)
  - Enabled (icon)
  - Force Update (icon)
  - Rollout % (badge with warning)
  - Message
  - Created (timestamp from UUIDv7)
- Pagination controls (server-side, 20 per page)

**Components to Build:**
- `BundlesTable.tsx` - Main table with TanStack Table
- `BundleTableColumns.tsx` - Column definitions
- `FilterToolbar.tsx` - Platform/channel filters
- `BundleTableRow.tsx` - Clickable row (opens editor)

**State Management:**
- URL search params for filters (via TanStack Router)
- TanStack Query for data fetching
- Local state for table sorting/pagination

#### 4.2 Bundle Editor Sheet
**Trigger:** Click any bundle row
**Position:** Right-side slide-out sheet

**Form Fields:**
- Message (textarea)
- Target App Version (text input with validation)
- Fingerprint Hash (read-only display)
- Enabled (switch)
- Force Update (switch)
- Rollout Percentage (slider, 0-100%, steps of 5%)
- Target Device IDs (textarea, multi-line)

**Metadata Display:**
- Platform (icon + name)
- App Version
- Git Commit (link if available)

**Action Buttons:**
- View Rollout Stats (opens dialog)
- Promote to Channel (opens dialog)
- Emergency Rollback (confirm → disable + 0% rollout)
- Delete Bundle (opens confirmation dialog)

**Components to Build:**
- `BundleEditorSheet.tsx` - Sheet container
- `BundleEditorForm.tsx` - Form with TanStack Form or React Hook Form
- `BundleMetadata.tsx` - Read-only metadata display

**Validation:**
- Semantic version format for target app version
- Rollout percentage 0-100
- Required fields: message

#### 4.3 Rollout Statistics Dialog
**Trigger:** "View Rollout Stats" button in editor
**Layout:** Modal dialog with statistics

**Data Display:**
- Total devices targeted
- Success rate (%)
- Promoted count
- Recovered count
- Last updated timestamp

**Components to Build:**
- `RolloutStatsDialog.tsx` - Dialog container
- `RolloutStatsDisplay.tsx` - Stats grid/cards

#### 4.4 Promote Channel Dialog
**Trigger:** "Promote to Channel" button in editor
**Layout:** Modal dialog with form

**Form Fields:**
- Target Channel (combobox/select from available channels)
- Operation Type (toggle: Copy or Move)

**Actions:**
- Confirm → Create bundle in target channel
- If Move → Delete from source channel

**Components to Build:**
- `PromoteChannelDialog.tsx` - Dialog container
- `PromoteChannelForm.tsx` - Form with channel selection

#### 4.5 Delete Confirmation Dialog
**Trigger:** "Delete Bundle" button in editor
**Layout:** Alert dialog with warning

**Content:**
- Warning message
- Bundle ID display
- Irreversible action notice

**Actions:**
- Cancel
- Confirm Delete → Call delete mutation

**Components to Build:**
- `DeleteBundleDialog.tsx` - Alert dialog with confirmation

#### 4.6 Emergency Rollback
**Trigger:** "Emergency Rollback" button in editor
**Behavior:** One-click action (or simple confirm)

**Actions:**
1. Set `enabled: false`
2. Set `rolloutPercentage: 0`
3. Show success toast

**Components to Build:**
- `EmergencyRollbackButton.tsx` - Button with confirmation

---

### Phase 5: Hooks & Utilities
Custom hooks for state management and business logic.

#### Tasks:
1. **Create filter hook**
   - `useFilterParams()` - Manage URL search params
   - Support platform, channel, bundleId filters
   - Sync with TanStack Router

2. **Create form hooks**
   - `useBundleForm()` - Bundle editor form state
   - `usePromoteForm()` - Promote channel form state

3. **Create UI hooks**
   - `useToast()` - shadcn toast notifications
   - `useConfirm()` - Reusable confirmation dialogs

**Files to Create:**
- `src/hooks/useFilterParams.ts`
- `src/hooks/useBundleForm.ts`
- `src/hooks/useToast.ts`

---

### Phase 6: Configuration & Integration
Set up Hot Updater configuration and testing.

#### Tasks:
1. **Port configuration**
   - Copy `hot-updater.config.ts` from console
   - Ensure mock storage + database plugins work
   - Test config loading endpoint

2. **Update package.json**
   - Add dependencies:
     - `@hot-updater/core`
     - `hono`
     - `typia` (runtime validation)
     - `dayjs` (date formatting)
     - `sonner` or `react-hot-toast` (notifications)
   - Keep existing TanStack dependencies
   - Remove Solid.js dependencies after migration complete

3. **Set up development workflow**
   - Configure `pnpm dev` to serve both frontend and backend
   - Test hot reload for both layers
   - Verify TypeScript compilation

---

### Phase 7: Testing & Validation
Ensure feature parity and quality.

#### Tasks:
1. **Feature checklist**
   - [ ] Bundle list displays with correct data
   - [ ] Platform filter (All, iOS, Android)
   - [ ] Channel filter (dynamic list)
   - [ ] Pagination (20 per page)
   - [ ] Bundle editor opens on row click
   - [ ] Edit form updates bundle on save
   - [ ] Rollout percentage slider works
   - [ ] Enable/disable toggle works
   - [ ] Force update toggle works
   - [ ] Target device IDs field works
   - [ ] Rollout stats dialog displays correct data
   - [ ] Promote channel dialog creates new bundle
   - [ ] Move operation deletes source bundle
   - [ ] Emergency rollback disables + sets 0%
   - [ ] Delete bundle removes from storage
   - [ ] Toast notifications appear on actions
   - [ ] Dark mode works across all components
   - [ ] Responsive layout on mobile/tablet/desktop

2. **Data integrity**
   - Verify UUIDv7 timestamp extraction
   - Test pagination state persistence
   - Test filter state in URL params
   - Test optimistic updates with TanStack Query

3. **Error handling**
   - Test API error states
   - Test form validation errors
   - Test network failures
   - Test loading states

4. **Performance**
   - Test with 100+ bundles
   - Verify pagination performance
   - Check query caching behavior
   - Test SSR/hydration

---

### Phase 8: Cleanup & Documentation
Finalize the migration.

#### Tasks:
1. **Remove demo content**
   - Delete `/demo` routes
   - Remove `ComponentExample.tsx`
   - Clean up unused demo data

2. **Update README**
   - Document new tech stack
   - Add development instructions
   - Document available features
   - Add screenshots/demos

3. **Deprecate old console**
   - Add deprecation notice to `packages/console/README.md`
   - Update root README to point to console2
   - Plan removal timeline (optional)

4. **CI/CD verification**
   - Run `pnpm build` - ensure success
   - Run `pnpm test:type` - no TypeScript errors
   - Run `pnpm lint` - pass Biome checks
   - Run `pnpm test` - all tests pass

---

## File Mapping Reference

### Backend Files
| Source (console) | Target (console2) | Notes |
|------------------|-------------------|-------|
| `src-server/index.ts` | `src-server/index.ts` | Adapt for Nitro |
| `src-server/rpc.ts` | `src-server/rpc.ts` | Keep as-is |
| `tsdown.config.ts` | `tsdown.config.ts` | Copy config |

### API & Utilities
| Source (console) | Target (console2) | Notes |
|------------------|-------------------|-------|
| `src/lib/api.ts` | `src/lib/api.ts` | Rewrite for React Query |
| `src/lib/extract-timestamp-from-uuidv7.ts` | `src/lib/extract-timestamp-from-uuidv7.ts` | Copy unchanged |
| `src/lib/utils.ts` | `src/lib/utils.ts` | Merge with existing |

### Hooks
| Source (console) | Target (console2) | Notes |
|------------------|-------------------|-------|
| `src/hooks/useFilter.tsx` | `src/hooks/useFilterParams.ts` | Rewrite for React Router |

### Components - Pages
| Source (console) | Target (console2) | Notes |
|------------------|-------------------|-------|
| `src/routes/index.tsx` | `src/routes/index.tsx` | Complete rewrite |

### Components - Features (New Structure)
All components in `src/routes/_components/` → `src/components/features/bundles/`

| Source (console) | Target (console2) |
|------------------|-------------------|
| `data-table.tsx` | `BundlesTable.tsx` |
| `columns.tsx` | `BundleTableColumns.tsx` |
| `edit-bundle-sheet-content.tsx` | `BundleEditorSheet.tsx` |
| `edit-bundle-sheet-form.tsx` | `BundleEditorForm.tsx` |
| `delete-bundle-dialog.tsx` | `DeleteBundleDialog.tsx` |
| `promote-channel-dialog.tsx` | `PromoteChannelDialog.tsx` |
| `rollout-stats-dialog.tsx` | `RolloutStatsDialog.tsx` |
| `emergency-rollback-button.tsx` | `EmergencyRollbackButton.tsx` |

### Components - UI (New Custom Components)
Add to `src/components/`:

- `PlatformIcon.tsx`
- `BundleIdDisplay.tsx`
- `RolloutPercentageBadge.tsx`
- `TimestampDisplay.tsx`
- `ChannelBadge.tsx`
- `EnabledStatusIcon.tsx`
- `BundleMetadata.tsx`
- `FilterToolbar.tsx`

---

## Design System Guidelines

### shadcn Philosophy
1. **Composition over Configuration**
   - Build complex UIs from simple primitives
   - Avoid prop drilling; use context when needed
   - Prefer explicit composition

2. **Accessibility First**
   - Use Radix UI primitives (already in shadcn)
   - Proper ARIA labels and roles
   - Keyboard navigation support

3. **Customizable by Default**
   - All components use CVA for variants
   - Easy to extend with Tailwind utilities
   - No inline styles; use Tailwind classes

4. **Consistent Spacing & Typography**
   - Use Tailwind spacing scale (4px base)
   - Follow shadcn's typography system
   - Maintain consistent border radius (from theme)

### Color Usage (oklch System)
- **Background**: `--background` and `--foreground`
- **Primary**: Main actions (save, confirm)
- **Secondary**: Less prominent actions
- **Destructive**: Delete, emergency actions (red)
- **Muted**: Disabled states, placeholders
- **Accent**: Highlights, badges

### Component Patterns
1. **Data Display**: Use Card components for grouped data
2. **Forms**: Use Field/FieldGroup for consistent error handling
3. **Actions**: Button variants (default, outline, ghost, destructive)
4. **Feedback**: Toast notifications for success/error
5. **Loading**: Skeleton loaders, not spinners

---

## Risk Mitigation

### Potential Issues
1. **SSR Compatibility**
   - Risk: Hono RPC might conflict with Nitro backend
   - Mitigation: Test thoroughly, consider API routes in TanStack Start

2. **Data Fetching Patterns**
   - Risk: React Query patterns differ from Solid Query
   - Mitigation: Follow TanStack Query v5 best practices

3. **Form Handling**
   - Risk: TanStack Form for React might have different API
   - Mitigation: Consider React Hook Form as alternative

4. **Routing State**
   - Risk: URL state management different in TanStack Router
   - Mitigation: Use search params API from TanStack Router

### Testing Strategy
- Unit test custom hooks
- Integration test RPC endpoints
- E2E test critical flows (edit bundle, promote, delete)
- Visual regression test UI components

---

## Success Criteria

### Functional Requirements
- ✅ All 9 RPC endpoints working
- ✅ All bundle management features operational
- ✅ Filter/pagination state persists in URL
- ✅ Optimistic updates with rollback on error
- ✅ Form validation working
- ✅ Toast notifications on all actions

### Non-Functional Requirements
- ✅ TypeScript strict mode with no errors
- ✅ Passes all CI/CD checks (build, lint, test, type-check)
- ✅ Dark mode fully functional
- ✅ Responsive on all screen sizes
- ✅ Accessible (WCAG 2.1 AA)
- ✅ Fast page loads (< 2s initial, < 500ms navigation)

### Developer Experience
- ✅ Hot reload working for both frontend and backend
- ✅ Clear component structure
- ✅ Reusable hooks and utilities
- ✅ Comprehensive README
- ✅ No console errors/warnings

---

## Timeline Estimate

This is a **medium-large migration** (framework change + UI redesign):

- Phase 1 (Backend): 2-3 hours
- Phase 2 (Data Layer): 1-2 hours
- Phase 3 (UI Components): 3-4 hours
- Phase 4 (Features): 5-7 hours
- Phase 5 (Hooks): 1-2 hours
- Phase 6 (Config): 1 hour
- Phase 7 (Testing): 2-3 hours
- Phase 8 (Cleanup): 1 hour

**Total: ~16-24 hours of focused development**

---

## Next Steps

1. Review this plan with stakeholders
2. Set up development environment for console2
3. Start with Phase 1 (Backend Migration)
4. Iterate through phases sequentially
5. Test continuously during development
6. Deploy to staging for validation
7. Final production deployment

---

## Questions to Resolve

1. **Form Library**: Use TanStack Form or React Hook Form?
2. **Toast Library**: Use Sonner or react-hot-toast?
3. **Table Library**: Continue with TanStack Table or use shadcn's table?
4. **Backend Integration**: Keep Hono or migrate to TanStack Start API routes?
5. **State Management**: Do we need TanStack Store or is React Query sufficient?

---

*This plan is a living document. Update as implementation progresses.*

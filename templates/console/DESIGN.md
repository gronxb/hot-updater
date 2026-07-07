# Hot Updater Console Design

## Purpose

The console is an operational control surface for OTA bundle management. It
prioritizes scan speed, safe edits, and clear status over marketing-style
presentation.

## Visual System

- Framework: TanStack Start, React 19, Tailwind CSS v4, shadcn-style
  components.
- Component style: `radix-mira` from `components.json`, using lucide icons.
- Typography: Inter via `@fontsource-variable/inter`.
- Color tokens: OKLCH CSS variables in `src/styles.css` for light and dark
  themes.
- Radius: compact controls and cards use the existing `0.45rem` radius token.
- Spacing: dense operational spacing with fixed-height controls and tables.

## Layout

The primary viewport is the bundle operations workspace: filters, paginated
table, editor sheets, and confirmation dialogs. Avoid landing pages, large hero
sections, nested cards, decorative gradients, and explanatory in-app text.

## Interaction Patterns

- Use segmented filters for platform/channel state.
- Use tables for bundle lists and repeated operational data.
- Use sheets for edit flows that should preserve table context.
- Use dialogs for destructive or high-impact operations.
- Use toasts only for concise success or error feedback.
- Keep development-only tools behind local development gates.

## Accessibility

Preserve shadcn/Radix semantics, visible focus states, keyboard navigation, and
text contrast from the existing token set. Buttons and icon controls need clear
accessible labels.

## Deployment Constraints

This template is deployable as a standalone app. UI code must not depend on
monorepo-only hosted entrypoints, demo data fixtures, or local-only package
aliases.

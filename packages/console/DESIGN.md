# Console Design Notes

- Preserve the existing operational dashboard tone: compact headers, quiet cards,
  border-based grouping, and small action buttons.
- Keep settings panels narrow (`max-w-2xl`) and focused on one provider
  capability per card.
- Use shadcn primitives already present in the package and lucide icons for
  button affordances.
- Prefer terse status labels and concrete values over explanatory copy.
- For bundle detail surfaces, metrics should appear as scannable numeric tiles
  before edit controls, without nesting cards inside cards.

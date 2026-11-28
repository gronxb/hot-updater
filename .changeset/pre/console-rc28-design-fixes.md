---
"@hot-updater/console": patch
---

Console design fixes from the rc.28 review.

- **Install card on an iPhone.** Apple's refusal and a check that couldn't start show as the card's error, each with one next step. The computer's install options sit under "Other ways to install".
- **iOS devices page.**
  - Apple's refusal shows an "Apple refused" badge.
  - CLI-added devices are named "Added from a terminal".
  - The Approve dialog shows the full UDID.
  - The Remove dialog is shorter.
- **Native builds.** "Older" sits beside the kind, as Bundles shows "Unreachable".
- **Folded rows.** Folded rows on both tables are shaded more visibly, and light channel badges are slightly darker, so the rows keep AA contrast.
- **Page footer.** It counts what the page folds, such as "20 builds, newest first · 6 older folded".
- **IPA device list.** An unnamed device shows as "Unknown device" over its masked UDID, with the full UDID copyable.
- **Elsewhere.** A fold that fails names its rows, every spinner respects reduced motion, and empty values use one glyph.

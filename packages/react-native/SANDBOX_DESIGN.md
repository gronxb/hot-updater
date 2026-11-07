# Sandbox screen design

One design for the sandbox screen on both platforms: SwiftUI in
`ios/HotUpdater/Sandbox` and Compose in `android/src/sandbox`. It's a quiet
developer tool. The app's own icon and name lead the header, surfaces stay
neutral and system-like, and the text is Geist: Geist Sans for the interface,
Geist Mono for what's code-like, such as channels, fingerprints, bundle IDs and
hosts.

Orange appears in three places only: the primary action, the selected tab,
and the focus ring of a field. No brand-colored backgrounds, logos, or
gradients.

## Tokens

### Color

iOS uses the system color in the last column, so Increase Contrast and the
elevated dark surfaces come for free. Android uses the hex values.

| Token          | Light     | Dark      | iOS                                  |
| -------------- | --------- | --------- | ------------------------------------ |
| background     | `#F2F2F7` | `#000000` | `systemGroupedBackground`            |
| surface        | `#FFFFFF` | `#1C1C1E` | `secondarySystemGroupedBackground`   |
| surfacePressed | `#E5E5EA` | `#2C2C2E` | `systemGray5`                        |
| fill           | `#EFEFF4` | `#2C2C2E` | `tertiarySystemFill` on `surface`    |
| separator      | `#C6C6C8` | `#38383A` | `separator`                          |
| text           | `#000000` | `#FFFFFF` | `label`                              |
| textSecondary  | `#6C6C70` | `#98989F` | `secondaryLabel`                     |
| muted          | `#8E8E93` | `#8E8E93` | `systemGray`                         |
| accent         | `#F97316` | `#F97316` | the same hex                         |
| accentPressed  | `#EA580C` | `#EA580C` | the same hex                         |
| onAccent       | `#FFFFFF` | `#FFFFFF` | `white`                              |
| success        | `#34C759` | `#30D158` | `systemGreen`                        |
| danger         | `#FF3B30` | `#FF453A` | `systemRed`                          |

`fill` backs fields, badges, neutral icon tiles, and the monogram of an app
without an icon. `muted` is for chevrons, placeholders, and idle status dots.

### Type

Geist and Geist Mono 1.8.2 (SIL Open Font License 1.1), in Regular, Medium,
and SemiBold for Sans and Regular and Medium for Mono, ship only in a sandbox
build: as `src/sandbox/res/font` on Android, and on iOS as bytes in
`HotUpdaterSandboxFonts.swift`, registered for the process at the screen's
first use, since a pod's resources would reach every build. A script Geist
lacks, such as Korean, falls back to the system font.

Sizes are at the default text size. iOS scales them with Dynamic Type relative
to the text style named here, and Android uses `sp`, so the font scale scales
them.

| Role     | Size | Weight   | iOS text style | Used for                                    |
| -------- | ---- | -------- | -------------- | ------------------------------------------- |
| title    | 22   | semibold | `title2`       | the app name, the Info title                |
| headline | 17   | semibold | `headline`     | the primary row's title                     |
| body     | 17   | regular  | `body`         | action rows, the banner, fields, Info rows  |
| subhead  | 15   | regular  | `subheadline`  | row subtitles, dialog messages              |
| footnote | 13   | regular  | `footnote`     | row details, section footers, the hint      |
| label    | 13   | semibold | `footnote`     | section labels, uppercase, tracking 0.4     |
| badge    | 12   | semibold | `caption`      | badges, tab labels on Android               |
| code     | 15   | Mono     | `body`         | hosts and channels as row titles (Medium), Info values and fields (Regular) |

### Space, size, and shape

A 4-point grid, in points on iOS and `dp` on Android.

| Token          | Value | Used for                                          |
| -------------- | ----- | ------------------------------------------------- |
| gutter         | 16    | the page's side margin, a row's side padding      |
| rowPadding     | 12    | a row's vertical padding                          |
| rowMinHeight   | 52    | the least a row is tall; text that grows grows it |
| sectionGap     | 28    | between sections                                  |
| labelGap       | 8     | from a section label or footer to its card        |
| leadGap        | 12    | from a row's leading slot to its text             |
| tile           | 32    | a row's icon tile, radius 8                       |
| primaryTile    | 40    | the primary row's tile, radius 10                 |
| dot            | 10    | a status dot                                      |
| appIcon        | 56    | the header's app icon, radius 13                  |
| cardRadius     | 12    | cards                                             |
| control        | 48    | buttons and fields, radius 10                     |
| focusRing      | 2     | a focused field's ring, in `accent`               |

Icon tiles, the dot, and the app icon scale with the text size.

### Motion

Every expand and collapse animates the height and the content together: a
spring with a response of 0.35 s and a damping of 0.86. On Android that's
`spring(dampingRatio = 0.86f, stiffness = 320f)`. The content fades in as the
card grows, and the chevron turns 180° on the same spring. A field takes focus
once the card has opened, so the keyboard is its own second motion.

A pressed row or button changes its background at once and eases it back in
150 ms.

## Components

**Header.** The app icon at `appIcon`, with a hairline border in `separator`.
Beside it, the app name in `title`, and under it the version in `subhead`
`textSecondary` and a **Sandbox** badge. Over a running app, a 30-point
circular close button in `fill` with an `xmark` in `textSecondary`, labelled
"Back to the app".

**Section.** A `label` in `textSecondary`, with an optional action on the
right in `subhead` `accent`, such as **Help** or **Clear**. Then a card, then
an optional footer in `footnote` `textSecondary`.

**Card.** `surface`, `cardRadius`, no shadow. Rows inside are divided by a
hairline in `separator`, inset to where the row's text starts.

**Row.** A leading slot, then a title, an optional subtitle in `subhead`
`textSecondary`, and an optional detail in `footnote` `textSecondary`. A
chevron in `muted` when it opens something. Pressed, its background turns
`surfacePressed`. Disabled, it's at 40% opacity. The leading slot holds an icon
tile in `fill` with the glyph in `textSecondary`, or a status dot.

**Primary row.** The row that opens or reloads the app. Its tile is
`primaryTile` in `accent`, with a white glyph: play, or reload.

**Accordion.** A row whose chevron points down and turns up when open. Open,
it shows a field and a primary button, 12 apart, inside the same card, with
`gutter` around them. One accordion is open at a time. Its state is spoken:
"Expanded" or "Collapsed".

**Field.** `fill`, `control` tall, radius 10, `body` text, the placeholder in
`muted`. Focused, a `focusRing` in `accent`.

**Primary button.** `accent`, `control` tall, radius 10, `headline` in
`onAccent`. Pressed, `accentPressed`. Disabled, 40% opacity.

**Destructive row.** A row whose title is `body` in `danger`, centered by its
text, with no leading slot. It always asks first.

**Badge.** A capsule in `fill`, 8 by 2 padding, `badge` in `textSecondary`.

**Status.** A card with the text in `body`, and while a download reports it, a
4-point bar in `accent` over `fill`.

**Crash banner.** A card, not a colored one: a warning triangle in `danger`,
the text in `body`, and when the crashed bundle stays selected, a destructive
row **Reset to built-in bundle** under a hairline.

**History list.** The channels this device opened, newest first. Each row has a
clock tile, the channel in `code`, its message as the subtitle, and when it
was opened as the detail.

**Tabs.** Home and Info. The selected tab is `accent`, the other `muted`.

## Screens

**Home.** The header, then a status and a crash banner when there is one. Then
the primary row under the label the model gives it, the Dev server section,
the OTA previews section with **Scan QR code** and the **Enter a channel**
accordion, and the history list under **Recent**. The hint to shake the device
ends the page.

**Info.** The title, the Build and Bundle cards of name and value rows, and the
destructive row **Reset to built-in bundle** with the note under it, and
**Licenses**, whose row "Geist, SIL Open Font License 1.1" opens the license
the fonts ship with. At the largest text sizes, the name and value stack.

**Wide windows.** From 600 points wide (dp on Android), such as an
open foldable, a tablet, or a phone on its side, Home and Info sit side by side
with no tabs. On a foldable neither sits on the fold: iOS lays them out with
`ArrangementView` and its split style from iOS 27.1, and Android splits at the
hinge `androidx.window` reports, beside it or, on a table, above and below it.
Folding, unfolding, rotating, and a new text size keep what a person is in the
middle of: the tab, the open form and what's typed, an open question or sheet,
and, from iOS 17 on iOS, where each page is scrolled. Each page stays at most 640 wide.

## Platform behavior

Each platform keeps its own:

- **iOS:** system alerts for questions, a confirmation dialog before anything
  destructive, the scanner as a sheet, `NavigationStack` bars whose items have
  an icon and a title, haptics through `UIFeedbackGenerator`,
  Dynamic Type, and VoiceOver labels. The screen needs iOS 16. Older systems
  get a plain screen that opens the app and takes a channel.
- **Android:** system back and predictive back, edge-to-edge with insets, the
  pressed state above, haptics through `performHapticFeedback`, the font scale,
  and TalkBack descriptions. Questions use the same card as a dialog, with
  text buttons: the main one in `accent`, a destructive one in `danger`.

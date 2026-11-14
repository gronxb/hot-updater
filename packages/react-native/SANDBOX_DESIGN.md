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
| surfacePressed | `#EFEFF4` | `#2C2C2E` | the same hexes, by trait             |
| fill           | `#EFEFF4` | `#2C2C2E` | `tertiarySystemFill` on `surface`    |
| separator      | `#C6C6C8` | `#38383A` | `separator`                          |
| text           | `#000000` | `#FFFFFF` | `label`                              |
| textSecondary  | `#6C6C70` | `#98989F` | `secondaryLabel`                     |
| muted          | `#8E8E93` | `#8E8E93` | `systemGray`                         |
| accent         | `#F97316` | `#F97316` | the same hex                         |
| accentPressed  | `#EA580C` | `#EA580C` | the same hex                         |
| accentText     | `#C2410C` | `#F97316` | the same hexes, by trait             |
| onAccent       | `#1F1F1F` | `#1F1F1F` | the same hex                         |
| danger         | `#FF3B30` | `#FF453A` | `systemRed`                          |
| dangerText     | `#C4161C` | `#FF6961` | the same hexes, by trait             |

`fill` backs fields, badges, neutral icon tiles, and the monogram of an app
without an icon. `muted` is for chevrons. Placeholders are `textSecondary`, which reads at AA
on `fill`.

`accent` is the brand orange as a fill, under `onAccent` (5.88:1). Orange
drawn on a surface, such as text, a ring, a bar or the selected tab, is
`accentText`, which is darker in light mode so it reads at AA (5.18:1 on
white). `danger` is for the warning icon; a destructive action's text is
`dangerText`, which reads at AA on a surface and pressed. A text or icon
action presses to `fill`, opaque on both platforms (iOS draws the hexes, not
`tertiarySystemFill`), under which `accentText` reads at 4.52:1 light and
4.97:1 dark.
A pressed row is `surfacePressed`, under which `textSecondary` reads at
4.56:1 light and 4.86:1 dark. `text` and `textSecondary` stay the platform's label colors, so they follow
dark mode and Increase Contrast.

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
| appIcon        | 56    | the header's app icon, radius 13                  |
| cardRadius     | 12    | cards                                             |
| control        | 48    | buttons and fields, radius 10                     |
| focusRing      | 2     | a focused field's ring, in `accentText`           |

Icon tiles and the app icon scale with the text size.

### Motion

Every expand and collapse animates the height and the content together: a
spring with a response of 0.35 s and a damping of 0.86. On Android that's
`spring(dampingRatio = 0.86f, stiffness = 320f)`. The content fades in as the
card grows, and the chevron turns 180° on the same spring. A field takes focus
once the card has opened, so the keyboard is its own second motion.

A pressed row or button changes its background at once and eases it back in
150 ms.

With Reduce Motion on iOS, or animations off on Android (an animator duration
scale of 0), nothing springs: a card opens and closes in place, and the
chevron turns at once. Both follow the setting while the screen is up.

## Components

**Header.** The app icon at `appIcon`, with a hairline border in `separator`.
Beside it, the app name in `title`, and under it the version in `subhead`
`textSecondary` and a **Sandbox** badge. Over a running app, a 30-point
circular close button in `fill` with an `xmark` in `textSecondary`, labelled
"Back to the app".

**Section.** A `label` in `textSecondary`, with an optional action on the
right in `subhead` `accentText`, such as **Clear**, with a 44-point (48 dp)
target. Then a card, then
an optional footer in `footnote` `textSecondary`.

**Card.** `surface`, `cardRadius`, no shadow. Rows inside are divided by a
hairline in `separator`, inset to where the row's text starts.

**Row.** A leading slot, then a title, an optional subtitle in `subhead`
`textSecondary`, and an optional detail in `footnote` `textSecondary`. A
chevron in `muted` when it opens something. Pressed, its background turns
`surfacePressed`. Disabled, it's at 40% opacity. The leading slot holds an icon
tile in `fill` with the glyph in `textSecondary`.

**Primary row.** The row that opens or reloads the app. Its tile is
`primaryTile` in `accent`, with the glyph in `onAccent`: play, or reload.

**Accordion.** A row whose chevron points down and turns up when open. Closed,
it can show a value in `code` `textSecondary` as its detail line. Open, it
shows a field and a primary button, 12 apart, inside the same card, with
`gutter` around them. One accordion is open at a time. Its state is spoken:
"Expanded" or "Collapsed".

**Field.** `fill`, `control` tall, radius 10, `body` text, the placeholder in
`textSecondary`. Focused, a `focusRing` in `accentText`.

**Primary button.** `accent`, `control` tall, radius 10, `headline` in
`onAccent`. Pressed, `accentPressed`. Disabled, 40% opacity.

**Destructive row.** A row whose title is `body` in `dangerText`, centered by its
text, with no leading slot. It always asks first.

**Badge.** A capsule in `fill`, 8 by 2 padding, `badge` in `textSecondary`.

**Status.** A card with the text in `body`, and while a download reports it, a
4-point bar in `accentText` over `fill`.

**Crash banner.** A card, not a colored one: a warning triangle in `danger`,
the text in `body`, and when the crashed bundle stays selected, a destructive
row **Reset to built-in bundle** under a hairline.

**Downloaded list.** The bundles the sandbox's switches downloaded, newest
first, at most 10. Each row has a box tile, the channel in `code`, its message as
the subtitle, and its bundle and when it was downloaded as the detail. The running
one shows a **Running** badge in place of the chevron. Pressed and held, a row
offers **Check `<channel>` for a newer bundle** and **Delete**: a context menu on
iOS, the dialog card on Android. The footer gives the count and size, or, while
empty, what the list is for. A stored bundle running puts **Back to current
bundle** under the primary row.

**Tabs.** Home and Info. The selected tab is `accentText`, the other
`textSecondary`.

## Screens

**Home.** The header, then a status and a crash banner when there is one. Then
the primary row under the label the model gives it, the Channels section with
**Scan a channel QR code** and the **Enter a channel** accordion, the
Downloaded list under **Downloaded**, and the dev server card. The hint to
shake the device ends the page.

**Dev server card.** One card with no section label, after Downloaded. With
no dev server running, it's an accordion titled **Dev server** with a link
tile; closed, its value is the first saved host that answered. Open, it lists
the saved hosts as `fill` buttons, `control` tall, with the host in `code` and
its state in `footnote` (**Running**, "Not running…", **Tap to open**); a held
host turns `surface`, the card's own color, since no shade darker than `fill`
keeps `textSecondary` at AA. Then
the address field, **Open**, and a **Help** text button in `accentText`. While
Home is busy, all of them are disabled. With a dev server running, it's one
row: **Dev server** with the host in `code` (and the last error as the
subtitle), which reloads (its hint says "Reload"), then a help icon in
`textSecondary` labelled "Help", and a text button **Exit** in `accentText`,
labelled "Exit dev server".

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
  destructive, the scanner as a sheet (with camera access off, one line takes
  the viewfinder's place, and **Open Settings** follows unless the camera is
  restricted), `NavigationStack` bars whose items have an icon and a title,
  haptics through `UIFeedbackGenerator`, Dynamic Type, and VoiceOver labels. The screen needs iOS 16. Older systems
  get a plain screen that opens the app and takes a channel.
- **Android:** system back and predictive back, edge-to-edge with insets, the
  pressed state above, haptics through `performHapticFeedback`, the font scale,
  and TalkBack descriptions. Questions use the same card as a dialog, with
  text buttons: the main one in `accentText`, a destructive one in `dangerText`.

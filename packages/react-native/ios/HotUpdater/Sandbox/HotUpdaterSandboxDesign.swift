#if HOT_UPDATER_SANDBOX_LAYER
import SwiftUI
import UIKit

// The tokens and components of SANDBOX_DESIGN.md, which Android's
// HotUpdaterSandboxDesign.kt draws the same way.

@available(iOS 16.0, *)
enum SandboxColor {
    static let background = Color(UIColor.systemGroupedBackground)
    static let surface = Color(UIColor.secondarySystemGroupedBackground)
    /// A pressed row: light enough that `textSecondary` stays at AA on it
    /// (4.56:1 light, 4.86:1 dark).
    static let surfacePressed = Color(UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0x2C / 255, green: 0x2C / 255, blue: 0x2E / 255, alpha: 1)
            : UIColor(red: 0xEF / 255, green: 0xEF / 255, blue: 0xF4 / 255, alpha: 1)
    })
    /// Opaque, Android's hexes, not the translucent `tertiarySystemFill`: text
    /// sits on it (badges, fields, saved hosts, pressed text actions), so its AA
    /// pair can't depend on what's underneath, such as a held row.
    static let fill = Color(UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0x2C / 255, green: 0x2C / 255, blue: 0x2E / 255, alpha: 1)
            : UIColor(red: 0xEF / 255, green: 0xEF / 255, blue: 0xF4 / 255, alpha: 1)
    })
    static let separator = Color(UIColor.separator)
    static let text = Color(UIColor.label)
    /// Android's hexes: the system `secondaryLabel` is translucent, 3.44:1 on
    /// the card in light mode. With Increase Contrast on, the system's own
    /// high-contrast color, which is darker still.
    static let textSecondary = Color(UIColor { traits in
        if traits.accessibilityContrast == .high {
            return UIColor.secondaryLabel.resolvedColor(with: traits)
        }
        return traits.userInterfaceStyle == .dark
            ? UIColor(red: 0x98 / 255, green: 0x98 / 255, blue: 0x9F / 255, alpha: 1)
            : UIColor(red: 0x6C / 255, green: 0x6C / 255, blue: 0x70 / 255, alpha: 1)
    })
    static let muted = Color(UIColor.systemGray)
    /// The brand orange as a fill: primary buttons and the primary tile.
    static let accent = Color(red: 0xF9 / 255, green: 0x73 / 255, blue: 0x16 / 255)
    static let accentPressed = Color(red: 0xEA / 255, green: 0x58 / 255, blue: 0x0C / 255)
    /// What sits on `accent`: 5.88:1 on it, 4.63:1 on `accentPressed`.
    static let onAccent = Color(red: 0x1F / 255, green: 0x1F / 255, blue: 0x1F / 255)
    /// Orange drawn on a surface, such as text, a focus ring, or a progress bar:
    /// darker in light mode so it reads at AA (5.18:1 on white).
    static let accentText = Color(UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0xF9 / 255, green: 0x73 / 255, blue: 0x16 / 255, alpha: 1)
            : UIColor(red: 0xC2 / 255, green: 0x41 / 255, blue: 0x0C / 255, alpha: 1)
    })
    /// The warning icon.
    static let danger = Color(UIColor.systemRed)
    /// A destructive action's text: AA on a surface and pressed (6.04:1 and
    /// 4.81:1 light, 6.03:1 and 4.94:1 dark).
    static let dangerText = Color(UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0xFF / 255, green: 0x69 / 255, blue: 0x61 / 255, alpha: 1)
            : UIColor(red: 0xC4 / 255, green: 0x16 / 255, blue: 0x1C / 255, alpha: 1)
    })
}

/// Geist Sans for the interface and Geist Mono for what's code-like: channels,
/// fingerprints, bundle IDs, hosts. Each scales with Dynamic Type from the
/// design's size, and a script Geist lacks falls back to the system font.
@available(iOS 16.0, *)
enum SandboxFont {
    static let title = sans(.semibold, 22, .title2)
    static let headline = sans(.semibold, 17, .headline)
    static let body = sans(.regular, 17, .body)
    static let subhead = sans(.regular, 15, .subheadline)
    static let footnote = sans(.regular, 13, .footnote)
    static let label = sans(.semibold, 13, .footnote)
    static let badge = sans(.semibold, 12, .caption)
    static let button = sans(.semibold, 17, .headline)
    static let codeHeadline = mono(.medium, 15, .headline)
    static let code = mono(.regular, 15, .body)

    enum Weight {
        case regular, medium, semibold
    }

    static func sans(_ weight: Weight, _ size: CGFloat, _ style: Font.TextStyle) -> Font {
        HotUpdaterSandboxFonts.register()
        let name: String
        switch weight {
        case .regular: name = "Geist-Regular"
        case .medium: name = "Geist-Medium"
        case .semibold: name = "Geist-SemiBold"
        }
        return .custom(name, size: size, relativeTo: style)
    }

    static func mono(_ weight: Weight, _ size: CGFloat, _ style: Font.TextStyle) -> Font {
        HotUpdaterSandboxFonts.register()
        return .custom(weight == .regular ? "GeistMono-Regular" : "GeistMono-Medium", size: size, relativeTo: style)
    }
}

@available(iOS 16.0, *)
enum SandboxMotion {
    /// None while Reduce Motion is on: what changes then appears in place.
    static var spring: Animation? {
        UIAccessibility.isReduceMotionEnabled ? nil : .spring(response: 0.35, dampingFraction: 0.86)
    }

    static var release: Animation? {
        UIAccessibility.isReduceMotionEnabled ? nil : .easeOut(duration: 0.15)
    }
}

enum SandboxHaptic {
    static func tap() {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }

    static func toggle() {
        UISelectionFeedbackGenerator().selectionChanged()
    }

    static func warning() {
        UINotificationFeedbackGenerator().notificationOccurred(.warning)
    }

    static func error() {
        UINotificationFeedbackGenerator().notificationOccurred(.error)
    }
}

// MARK: - Layout

@available(iOS 16.0, *)
struct SandboxSection<Content: View>: View {
    let title: String?
    var action: (title: String, run: () -> Void)?
    var footer: String?
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let title {
                HStack(alignment: .firstTextBaseline) {
                    Text(title.uppercased())
                        .font(SandboxFont.label)
                        .tracking(0.4)
                        .foregroundColor(SandboxColor.textSecondary)
                        .accessibilityAddTraits(.isHeader)
                    Spacer(minLength: 8)
                    if let action {
                        Button(action: action.run) {
                            Text(action.title)
                                .font(SandboxFont.subhead)
                                .foregroundColor(SandboxColor.accentText)
                                .padding(.horizontal, 6)
                                .frame(minWidth: 44, minHeight: 44)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(SandboxTextButtonStyle())
                    }
                }
                .padding(.horizontal, 16)
            }
            content
            if let footer {
                Text(footer)
                    .font(SandboxFont.footnote)
                    .foregroundColor(SandboxColor.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 16)
            }
        }
    }
}

@available(iOS 16.0, *)
struct SandboxCard<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        VStack(spacing: 0) { content }
            .background(SandboxColor.surface)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

/// A hairline between rows, from where the row's text starts.
@available(iOS 16.0, *)
struct SandboxDivider: View {
    var leading: Bool = true
    @ScaledMetric(relativeTo: .body) private var tile: CGFloat = 32
    @Environment(\.displayScale) private var displayScale

    var body: some View {
        Rectangle()
            .fill(SandboxColor.separator)
            .frame(height: 1 / displayScale)
            .padding(.leading, leading ? 16 + tile + 12 : 16)
    }
}

// MARK: - Rows

@available(iOS 16.0, *)
enum SandboxLead {
    case icon(String)
    case primary(String)
}

@available(iOS 16.0, *)
struct SandboxLeadView: View {
    let lead: SandboxLead
    @ScaledMetric(relativeTo: .body) private var scaledTile: CGFloat = 32
    @ScaledMetric(relativeTo: .body) private var scaledPrimaryTile: CGFloat = 40
    // They grow with the text, up to where they'd crowd it.
    private var tile: CGFloat { min(scaledTile, 48) }
    private var primaryTile: CGFloat { min(scaledPrimaryTile, 56) }

    var body: some View {
        switch lead {
        case .icon(let name):
            Image(systemName: name)
                .font(.system(size: tile * 0.5, weight: .medium))
                .foregroundColor(SandboxColor.textSecondary)
                .frame(width: tile, height: tile)
                .background(SandboxColor.fill, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        case .primary(let name):
            Image(systemName: name)
                .font(.system(size: primaryTile * 0.45, weight: .semibold))
                .foregroundColor(SandboxColor.onAccent)
                .frame(width: primaryTile, height: primaryTile)
                .background(SandboxColor.accent, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        }
    }
}

/// A text or icon action's look: pressed, `fill` behind it, under which
/// `accentText` still reads at AA.
@available(iOS 16.0, *)
struct SandboxTextButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(
                configuration.isPressed ? SandboxColor.fill : Color.clear,
                in: RoundedRectangle(cornerRadius: 8, style: .continuous)
            )
            .animation(configuration.isPressed ? nil : SandboxMotion.release, value: configuration.isPressed)
    }
}

/// A row's look: its pressed background turns at once and eases back.
@available(iOS 16.0, *)
struct SandboxRowStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(configuration.isPressed ? SandboxColor.surfacePressed : Color.clear)
            .animation(configuration.isPressed ? nil : SandboxMotion.release, value: configuration.isPressed)
    }
}

@available(iOS 16.0, *)
struct SandboxRowContent<Trailing: View>: View {
    let lead: SandboxLead?
    let title: String
    var titleFont = SandboxFont.body
    var subtitle: String?
    var detail: String?
    var detailFont = SandboxFont.footnote
    /// The detail's lines at most, ending in an ellipsis; nil wraps it whole.
    var detailLineLimit: Int?
    @ViewBuilder let trailing: Trailing
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        // At the accessibility sizes the lead sits above the text, which then has the width.
        let layout = typeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8))
            : AnyLayout(HStackLayout(spacing: 12))
        HStack(spacing: 8) {
            layout {
                if let lead { SandboxLeadView(lead: lead) }
                text
            }
            Spacer(minLength: 0)
            trailing
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, minHeight: 52, alignment: .leading)
        .contentShape(Rectangle())
    }

    private var text: some View {
        VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(titleFont)
                    .foregroundColor(SandboxColor.text)
                if let subtitle {
                    Text(subtitle)
                        .font(SandboxFont.subhead)
                        .foregroundColor(SandboxColor.textSecondary)
                }
                if let detail {
                    Text(detail)
                        .font(detailFont)
                        .foregroundColor(SandboxColor.textSecondary)
                        .lineLimit(detailLineLimit)
                        .truncationMode(.tail)
                }
            }
            .multilineTextAlignment(.leading)
            .fixedSize(horizontal: false, vertical: true)
    }
}

@available(iOS 16.0, *)
struct SandboxChevron: View {
    var body: some View {
        Image(systemName: "chevron.right")
            .font(.footnote.weight(.semibold))
            .foregroundColor(SandboxColor.muted)
            .accessibilityHidden(true)
    }
}

@available(iOS 16.0, *)
struct SandboxRow: View {
    let lead: SandboxLead?
    let title: String
    var titleFont = SandboxFont.body
    var subtitle: String?
    var detail: String?
    var detailFont = SandboxFont.footnote
    var detailLineLimit: Int?
    var showsChevron = true
    var isEnabled = true
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            SandboxRowContent(
                lead: lead,
                title: title,
                titleFont: titleFont,
                subtitle: subtitle,
                detail: detail,
                detailFont: detailFont,
                detailLineLimit: detailLineLimit
            ) {
                if showsChevron { SandboxChevron() }
            }
        }
        .buttonStyle(SandboxRowStyle())
        .disabled(!isEnabled)
        .opacity(isEnabled ? 1 : 0.4)
    }
}

@available(iOS 16.0, *)
struct SandboxDestructiveRow: View {
    let title: String
    var isEnabled = true
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(SandboxFont.body)
                .foregroundColor(SandboxColor.dangerText)
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                .frame(maxWidth: .infinity, minHeight: 52)
                .contentShape(Rectangle())
        }
        .buttonStyle(SandboxRowStyle())
        .disabled(!isEnabled)
        .opacity(isEnabled ? 1 : 0.4)
    }
}

// MARK: - Controls

@available(iOS 16.0, *)
struct SandboxPrimaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(SandboxFont.button)
            .foregroundColor(SandboxColor.onAccent)
            .frame(maxWidth: .infinity, minHeight: 48)
            .background(
                configuration.isPressed ? SandboxColor.accentPressed : SandboxColor.accent,
                in: RoundedRectangle(cornerRadius: 10, style: .continuous)
            )
            .opacity(isEnabled ? 1 : 0.4)
            .animation(configuration.isPressed ? nil : SandboxMotion.release, value: configuration.isPressed)
    }
}

@available(iOS 16.0, *)
struct SandboxBadge: View {
    let text: String

    var body: some View {
        Text(text)
            .font(SandboxFont.badge)
            .foregroundColor(SandboxColor.textSecondary)
            .padding(.horizontal, 8)
            .padding(.vertical, 2)
            .background(SandboxColor.fill, in: Capsule())
            .fixedSize()
    }
}

/// A field, `fill` with a ring in `accentText` while it's focused.
@available(iOS 16.0, *)
struct SandboxFieldStyle: ViewModifier {
    let isFocused: Bool

    func body(content: Content) -> some View {
        content
            .font(SandboxFont.code)
            .padding(.horizontal, 12)
            .frame(minHeight: 48)
            .background(SandboxColor.fill, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .strokeBorder(SandboxColor.accentText, lineWidth: isFocused ? 2 : 0)
            )
    }
}

/// A host used before, inside the dev server form: its address and whether it answered.
@available(iOS 16.0, *)
struct SandboxHostButton: View {
    let address: String
    let status: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(address)
                        .font(SandboxFont.code)
                        .foregroundColor(SandboxColor.text)
                    Text(status)
                        .font(SandboxFont.footnote)
                        .foregroundColor(SandboxColor.textSecondary)
                }
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                SandboxChevron()
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(SandboxHostButtonStyle())
    }
}

@available(iOS 16.0, *)
private struct SandboxHostButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(
                // It rests on `fill`, so it presses to the card's own `surface`:
                // no shade darker than `fill` keeps `textSecondary` at AA.
                configuration.isPressed ? SandboxColor.surface : SandboxColor.fill,
                in: RoundedRectangle(cornerRadius: 10, style: .continuous)
            )
            .animation(configuration.isPressed ? nil : SandboxMotion.release, value: configuration.isPressed)
    }
}

/// A row that opens a field and a button in its own card, on the design's spring.
@available(iOS 16.0, *)
struct SandboxAccordion<Content: View>: View {
    let lead: SandboxLead
    let title: String
    /// Shown under the title while closed, such as a dev server that answered.
    var value: String?
    let isExpanded: Bool
    var isEnabled = true
    let toggle: () -> Void
    @ViewBuilder let content: Content

    var body: some View {
        VStack(spacing: 0) {
            Button(action: toggle) {
                SandboxRowContent(
                    lead: lead,
                    title: title,
                    detail: isExpanded ? nil : value,
                    detailFont: SandboxFont.code
                ) {
                    Image(systemName: "chevron.down")
                        .font(.footnote.weight(.semibold))
                        .foregroundColor(SandboxColor.muted)
                        .rotationEffect(.degrees(isExpanded ? 180 : 0))
                        .accessibilityHidden(true)
                }
            }
            .buttonStyle(SandboxRowStyle())
            .accessibilityValue(isExpanded ? "Expanded" : "Collapsed")
            .accessibilityHint(isExpanded ? "Collapses the form" : "Opens a form")
            if isExpanded {
                VStack(spacing: 12) { content }
                    .padding(.horizontal, 16)
                    .padding(.bottom, 16)
                    .padding(.top, 4)
                    .transition(.opacity)
            }
        }
        .clipped()
        .disabled(!isEnabled)
        .opacity(isEnabled ? 1 : 0.4)
    }
}
#endif

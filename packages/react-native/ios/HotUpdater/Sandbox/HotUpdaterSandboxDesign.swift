#if HOT_UPDATER_SANDBOX_LAYER
import SwiftUI
import UIKit

// The tokens and components of SANDBOX_DESIGN.md, which Android's
// HotUpdaterSandboxDesign.kt draws the same way.

@available(iOS 16.0, *)
enum SandboxColor {
    static let background = Color(UIColor.systemGroupedBackground)
    static let surface = Color(UIColor.secondarySystemGroupedBackground)
    static let surfacePressed = Color(UIColor.systemGray5)
    static let fill = Color(UIColor.tertiarySystemFill)
    static let separator = Color(UIColor.separator)
    static let text = Color(UIColor.label)
    static let textSecondary = Color(UIColor.secondaryLabel)
    static let muted = Color(UIColor.systemGray)
    static let accent = Color(red: 0xF9 / 255, green: 0x73 / 255, blue: 0x16 / 255)
    static let accentPressed = Color(red: 0xEA / 255, green: 0x58 / 255, blue: 0x0C / 255)
    static let success = Color(UIColor.systemGreen)
    static let danger = Color(UIColor.systemRed)
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
    static let spring = Animation.spring(response: 0.35, dampingFraction: 0.86)
    static let release = Animation.easeOut(duration: 0.15)
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
                        Button(action.title, action: action.run)
                            .font(SandboxFont.subhead)
                            .foregroundColor(SandboxColor.accent)
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
    case dot(Color)
    case primary(String)
}

@available(iOS 16.0, *)
struct SandboxLeadView: View {
    let lead: SandboxLead
    @ScaledMetric(relativeTo: .body) private var scaledTile: CGFloat = 32
    @ScaledMetric(relativeTo: .body) private var scaledPrimaryTile: CGFloat = 40
    @ScaledMetric(relativeTo: .body) private var scaledDot: CGFloat = 10
    // They grow with the text, up to where they'd crowd it.
    private var tile: CGFloat { min(scaledTile, 48) }
    private var primaryTile: CGFloat { min(scaledPrimaryTile, 56) }
    private var dot: CGFloat { min(scaledDot, 14) }

    var body: some View {
        switch lead {
        case .icon(let name):
            Image(systemName: name)
                .font(.system(size: tile * 0.5, weight: .medium))
                .foregroundColor(SandboxColor.textSecondary)
                .frame(width: tile, height: tile)
                .background(SandboxColor.fill, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        case .dot(let color):
            Circle()
                .fill(color)
                .frame(width: dot, height: dot)
                .frame(width: tile, height: tile)
        case .primary(let name):
            Image(systemName: name)
                .font(.system(size: primaryTile * 0.45, weight: .semibold))
                .foregroundColor(.white)
                .frame(width: primaryTile, height: primaryTile)
                .background(SandboxColor.accent, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        }
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
                detailFont: detailFont
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
                .foregroundColor(SandboxColor.danger)
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
            .foregroundColor(.white)
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

/// A field, `fill` with a ring in `accent` while it's focused.
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
                    .strokeBorder(SandboxColor.accent, lineWidth: isFocused ? 2 : 0)
            )
    }
}

/// A row that opens a field and a button in its own card, on the design's spring.
@available(iOS 16.0, *)
struct SandboxAccordion<Content: View>: View {
    let lead: SandboxLead
    let title: String
    let isExpanded: Bool
    var isEnabled = true
    let toggle: () -> Void
    @ViewBuilder let content: Content

    var body: some View {
        VStack(spacing: 0) {
            Button(action: toggle) {
                SandboxRowContent(lead: lead, title: title) {
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

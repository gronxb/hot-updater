#if HOT_UPDATER_SANDBOX_LAYER
import Foundation

/// Whether a launch is a person opening the app, or something addressed to the app.
@objc(HotUpdaterSandboxLaunchPolicy)
public final class HotUpdaterSandboxLaunchPolicy: NSObject {
    /// The keys that come with a link, whichever app sent it.
    private static let linkKeys: Set<String> = [
        "UIApplicationLaunchOptionsURLKey",
        "UIApplicationLaunchOptionsSourceApplicationKey",
        "UIApplicationLaunchOptionsAnnotationKey",
    ]

    /// Any launch option is a reason the system gave for starting the app: its
    /// own link, an activity, a notification, a shortcut, a location event. So
    /// the app starts at once, and it's a sandbox link alone that doesn't count.
    @objc public static func isForTheApp(optionKeys: [String], urlScheme: String?) -> Bool {
        isForTheApp(optionKeys: optionKeys, urlScheme: urlScheme, own: HotUpdaterSandboxLink.ownScheme)
    }

    /// `own` is this build's URL scheme: another scheme's link is the app's.
    static func isForTheApp(optionKeys: [String], urlScheme: String?, own: String?) -> Bool {
        if HotUpdaterSandboxLink.isOwnScheme(urlScheme, own: own) {
            return optionKeys.contains { !linkKeys.contains($0) }
        }
        return !optionKeys.isEmpty
    }

    /// The launch options a sandbox link's keys are removed from.
    @objc public static func keysOfLink() -> [String] {
        Array(linkKeys)
    }

    /// Whether a URL scheme is this build's own, read once at launch.
    @objc public static func isSandboxScheme(_ scheme: String?) -> Bool {
        HotUpdaterSandboxLink.isOwnScheme(scheme)
    }
}
#endif

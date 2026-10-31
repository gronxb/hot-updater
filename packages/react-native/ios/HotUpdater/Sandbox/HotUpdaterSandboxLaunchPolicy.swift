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
        if HotUpdaterSandboxLink.isSandboxScheme(urlScheme) {
            return optionKeys.contains { !linkKeys.contains($0) }
        }
        return !optionKeys.isEmpty
    }

    /// The launch options a sandbox link's keys are removed from.
    @objc public static func keysOfLink() -> [String] {
        Array(linkKeys)
    }

    @objc public static func isSandboxScheme(_ scheme: String?) -> Bool {
        HotUpdaterSandboxLink.isSandboxScheme(scheme)
    }
}

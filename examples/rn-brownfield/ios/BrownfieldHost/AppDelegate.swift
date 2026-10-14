import UIKit
import RnBrownfieldReact

@main
class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        // Point the brownfield runtime at the JS bundle embedded in
        // RnBrownfieldReact.xcframework and start React Native.
        ReactNativeBrownfield.shared.bundle = ReactNativeBundle
        ReactNativeBrownfield.shared.startReactNative {
            print("[BrownfieldHost] React Native bundle loaded")
        }

        // "RnBrownfield" is the component registered in the React Native
        // project's index.js.
        let reactNativeViewController = ReactNativeViewController(
            moduleName: "RnBrownfield",
            initialProperties: ["host": "BrownfieldHost (iOS)"]
        )

        window = UIWindow(frame: UIScreen.main.bounds)
        window?.rootViewController = reactNativeViewController
        window?.makeKeyAndVisible()
        return true
    }
}

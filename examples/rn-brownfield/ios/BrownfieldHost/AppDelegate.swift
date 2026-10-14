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
        // RnBrownfieldReact.xcframework and start React Native ahead of time,
        // so the React Native screen is ready when the user opens it.
        ReactNativeBrownfield.shared.bundle = ReactNativeBundle
        ReactNativeBrownfield.shared.startReactNative {
            print("[BrownfieldHost] React Native bundle loaded")
        }

        // The native screen is the root of a UINavigationController; the React
        // Native screen is pushed onto it and popToNative() pops it again. The
        // navigation bar is hidden so both screens own the full display.
        let navigationController = UINavigationController(rootViewController: NativeViewController())
        navigationController.isNavigationBarHidden = true

        window = UIWindow(frame: UIScreen.main.bounds)
        window?.rootViewController = navigationController
        window?.makeKeyAndVisible()
        return true
    }
}

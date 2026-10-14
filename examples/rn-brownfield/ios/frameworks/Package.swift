// swift-tools-version: 5.9
import PackageDescription

// Wraps the XCFrameworks that `pnpm package:ios` in ../../react-native emits
// (copied here by `pnpm frameworks`) as one product the host app links.
let package = Package(
    name: "RnBrownfieldReact",
    platforms: [.iOS("18.0")],
    products: [
        .library(
            name: "RnBrownfieldReact",
            targets: [
                "RnBrownfieldReact",
                "ReactBrownfield",
                "hermesvm",
                "React",
                "ReactNativeDependencies",
            ]
        ),
    ],
    targets: [
        // The framework target of the React Native project: its JS bundle,
        // assets, native modules, and the ReactNativeBundle helper.
        .binaryTarget(name: "RnBrownfieldReact", path: "RnBrownfieldReact.xcframework"),
        // @callstack/react-native-brownfield's host API.
        .binaryTarget(name: "ReactBrownfield", path: "ReactBrownfield.xcframework"),
        // Hermes engine.
        .binaryTarget(name: "hermesvm", path: "hermesvm.xcframework"),
        // React Native core prebuilts.
        .binaryTarget(name: "React", path: "React.xcframework"),
        .binaryTarget(name: "ReactNativeDependencies", path: "ReactNativeDependencies.xcframework"),
    ]
)

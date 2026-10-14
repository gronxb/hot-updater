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
        // ReactBrownfield.xcframework is deliberately not a target: its code is
        // already inside RnBrownfieldReact.framework, and linking the static
        // archive too would give the host a second copy of every brownfield
        // class (two ReactNativeBrownfield.shared singletons, the pushed React
        // Native screen stays empty). The host's Swift compiler still needs the
        // `ReactBrownfield` module that RnBrownfieldReact re-exports, so the Xcode
        // project adds the xcframework's slice to FRAMEWORK_SEARCH_PATHS instead.
        // Hermes engine.
        .binaryTarget(name: "hermesvm", path: "hermesvm.xcframework"),
        // React Native core prebuilts.
        .binaryTarget(name: "React", path: "React.xcframework"),
        .binaryTarget(name: "ReactNativeDependencies", path: "ReactNativeDependencies.xcframework"),
    ]
)

import ProjectDescription

let project = Project(
    name: "HotUpdaterTests",
    targets: [
        .target(
            name: "HotUpdaterTests",
            destinations: .iOS,
            product: .unitTests,
            bundleId: "com.hotupdater.tests",
            deploymentTargets: .iOS("13.4"),
            infoPlist: .default,
            sources: [
                // Original implementation sources - directly referenced
                .glob(
                    "../../../packages/react-native/ios/HotUpdater/Internal/**/*.swift",
                    excluding: [
                        // Exclude files that depend on React Native
                        "../../../packages/react-native/ios/HotUpdater/Internal/HotUpdaterImpl.swift",
                        "../../../packages/react-native/ios/HotUpdater/Internal/HotUpdaterFactory.swift"
                    ]
                ),
                // Test files
                "Tests/HotUpdaterTests/**/*.swift"
            ],
            resources: [
                // Test resources (test bundles, etc.)
                "Tests/HotUpdaterTests/Resources/**"
            ],
            dependencies: [
                .external(name: "SWCompression")
            ],
            settings: .settings(
                base: [
                    // Use Swift 5 mode to avoid strict concurrency checks
                    "SWIFT_VERSION": "5.0",
                    // Disable strict concurrency
                    "SWIFT_STRICT_CONCURRENCY": "minimal",
                    // Suppress warnings from implementation code
                    "GCC_WARN_INHIBIT_ALL_WARNINGS": "YES",
                    "SWIFT_SUPPRESS_WARNINGS": "YES",
                    // Enable testability
                    "ENABLE_TESTABILITY": "YES"
                ],
                configurations: [
                    .debug(name: "Debug"),
                    .release(name: "Release")
                ]
            )
        )
    ],
    schemes: [
        .scheme(
            name: "HotUpdaterTests",
            shared: true,
            buildAction: .buildAction(targets: ["HotUpdaterTests"]),
            testAction: .targets(
                ["HotUpdaterTests"],
                configuration: .debug,
                options: .options(coverage: true)
            )
        )
    ]
)

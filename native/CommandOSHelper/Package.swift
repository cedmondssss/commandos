// swift-tools-version: 6.0
import Foundation
import PackageDescription

// Embed an Info.plist in the executable so TCC prompts (Apple Events) have usage descriptions.
let packageDir = URL(fileURLWithPath: #filePath).deletingLastPathComponent().path
let infoPlist = packageDir + "/Sources/CommandOSHelper/Info.plist"

let package = Package(
    name: "CommandOSHelper",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "CommandOSHelper", targets: ["CommandOSHelper"]),
    ],
    targets: [
        .target(
            name: "HelperCore",
            path: "Sources/HelperCore"
        ),
        .executableTarget(
            name: "CommandOSHelper",
            dependencies: ["HelperCore"],
            path: "Sources/CommandOSHelper",
            exclude: ["Info.plist"],
            linkerSettings: [
                .unsafeFlags(["-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", infoPlist]),
            ]
        ),
        .testTarget(
            name: "HelperCoreTests",
            dependencies: ["HelperCore"],
            path: "Tests/HelperCoreTests"
        ),
    ],
    swiftLanguageModes: [.v5]
)

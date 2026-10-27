// swift-tools-version: 6.2

import PackageDescription

let package = Package(
    name: "Polymux",
    platforms: [
        .iOS(.v26),
        .macOS(.v14),
    ],
    products: [
        .library(name: "Polymux", targets: ["Polymux"]),
        .library(name: "PolymuxWidget", targets: ["PolymuxWidget"]),
        .library(name: "PolymuxShare", targets: ["PolymuxShare"]),
    ],
    targets: [
        .target(name: "Polymux", dependencies: ["PolymuxShared"], resources: [.copy("Fonts")]),
        .target(name: "PolymuxWidget", dependencies: ["PolymuxShared"]),
        .target(name: "PolymuxShare", dependencies: ["PolymuxShared"]),
        .target(name: "PolymuxShared"),
    ]
)

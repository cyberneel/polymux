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
    ],
    targets: [
        .target(name: "Polymux", resources: [.copy("Fonts")]),
    ]
)

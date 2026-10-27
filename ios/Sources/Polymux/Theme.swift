import SwiftUI
import UIKit
import CoreText
import PolymuxShared

// FridayOS theme (the colors are in PolymuxShared, for the widget and share sheet too).
extension Font {
    // Schibsted Grotesk for everything. Sizes ride Dynamic Type.
    private static func points(_ s: Font.TextStyle) -> CGFloat {
        switch s {
        case .largeTitle: 34
        case .title: 28
        case .title2: 22
        case .title3: 20
        case .callout: 16
        case .subheadline: 15
        case .footnote: 13
        case .caption: 12
        case .caption2: 11
        default: 17
        }
    }
    static func sans(_ s: Font.TextStyle) -> Font {
        let f = Font.custom("Schibsted Grotesk", size: points(s), relativeTo: s)
        return s == .headline ? f.weight(.semibold) : f
    }

    // Register Fonts/*.ttf wherever the resource bundle lands in the .app; on failure Font.custom
    // falls back to the system font.
    static func registerBundled() {
        let all = FileManager.default.enumerator(at: Bundle.main.bundleURL, includingPropertiesForKeys: nil)?.allObjects ?? []
        let urls = all.compactMap { $0 as? URL }.filter { $0.pathExtension == "ttf" }
        CTFontManagerRegisterFontURLs(urls as CFArray, .process, true, nil)
    }
}

// Buttons: primary = Ink fill + bg label (the web's button.primary), ghost = fg edge. Square.
struct SquareButton: ButtonStyle {
    var primary = false
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration c: Configuration) -> some View {
        c.label
            .font(.sans(.callout).weight(primary ? .semibold : .regular))
            .foregroundStyle(primary ? Color.paper : .ink)
            .padding(.horizontal, 14).frame(minHeight: 44)
            .frame(maxWidth: primary ? .infinity : nil)
            .background(primary ? Color.plum : c.isPressed ? Color.sheet : .clear)
            .overlay(Rectangle().strokeBorder(primary ? Color.plum : .ink, lineWidth: 1))
            .opacity(enabled ? (c.isPressed && primary ? 0.82 : 1) : 0.5)
            .contentShape(.rect)
    }
}

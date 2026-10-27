import SwiftUI
import UIKit
import CoreText

// FridayOS theme, trimmed from friday/ios Theme.swift: black and white plus Polymux's Ink (plum, the
// web's --accent); color otherwise only when it means something — red = something's wrong.
extension Color {
    static func fb(_ l: (Double, Double, Double), _ d: (Double, Double, Double)) -> Color {
        Color(uiColor: UIColor { t in
            let c = t.userInterfaceStyle == .dark ? d : l
            return UIColor(red: c.0 / 255, green: c.1 / 255, blue: c.2 / 255, alpha: 1)
        })
    }
    static let paper    = fb((255, 255, 255), (0, 0, 0))      // bg
    static let sheet    = fb((245, 245, 245), (20, 20, 20))   // surface
    static let ink      = fb((0, 0, 0), (255, 255, 255))      // fg
    static let inkDim   = fb((92, 92, 92), (163, 163, 163))   // muted
    static let plum     = fb((122, 34, 145), (201, 144, 218)) // accent (#7a2291 / #c990da)
    static let redPencil = fb((168, 7, 26), (240, 74, 94))    // errors
}

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

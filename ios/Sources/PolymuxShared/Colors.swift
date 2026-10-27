import SwiftUI
import UIKit

// FridayOS colors, trimmed from friday/ios Theme.swift: black and white plus Polymux's Ink (plum, the
// web's --accent); color otherwise only when it means something — red = something's wrong.
public extension Color {
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
    static let redPencil = fb((168, 7, 26), (240, 74, 94))    // errors, and a session that needs you
}

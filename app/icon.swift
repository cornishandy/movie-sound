import AppKit
// Renders the Movie Sound icon: a dark rounded square with a white "speaker.wave.3.fill" symbol.
let size = 1024.0
let img = NSImage(size: NSSize(width: size, height: size))
img.lockFocus()
let rect = NSRect(x: 80, y: 80, width: size - 160, height: size - 160)
let bg = NSBezierPath(roundedRect: rect, xRadius: 190, yRadius: 190)
NSGradient(starting: NSColor(calibratedRed: 0.13, green: 0.16, blue: 0.24, alpha: 1), ending: NSColor(calibratedRed: 0.05, green: 0.06, blue: 0.10, alpha: 1))!.draw(in: bg, angle: -90)
let cfg = NSImage.SymbolConfiguration(pointSize: 520, weight: .semibold).applying(.init(paletteColors: [NSColor(calibratedRed: 0.37, green: 0.83, blue: 0.54, alpha: 1)]))
if let sym = NSImage(systemSymbolName: "speaker.wave.3.fill", accessibilityDescription: nil)?.withSymbolConfiguration(cfg) {
  let s = sym.size
  sym.draw(in: NSRect(x: (size - s.width) / 2, y: (size - s.height) / 2, width: s.width, height: s.height))
}
img.unlockFocus()
let rep = NSBitmapImageRep(data: img.tiffRepresentation!)!
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))

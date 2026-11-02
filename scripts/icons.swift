import AppKit

let destination = CommandLine.arguments[1]
try FileManager.default.createDirectory(atPath: destination + "/App.iconset", withIntermediateDirectories: true)

func render(_ size: Int, tray: Bool) -> Data {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let s = CGFloat(size)
    if !tray {
        NSColor(srgbRed: 0.055, green: 0.38, blue: 0.36, alpha: 1).setFill()
        NSBezierPath(roundedRect: NSRect(x: s * 0.06, y: s * 0.06, width: s * 0.88, height: s * 0.88),
                     xRadius: s * 0.2, yRadius: s * 0.2).fill()
    }
    (tray ? NSColor.black : NSColor.white).setStroke()
    let lines = NSBezierPath()
    lines.lineWidth = s * (tray ? 0.065 : 0.045)
    lines.lineJoinStyle = .round
    lines.move(to: NSPoint(x: s * 0.5, y: s * 0.66))
    lines.line(to: NSPoint(x: s * 0.5, y: s * 0.46))
    lines.move(to: NSPoint(x: s * 0.25, y: s * 0.34))
    lines.line(to: NSPoint(x: s * 0.25, y: s * 0.46))
    lines.line(to: NSPoint(x: s * 0.75, y: s * 0.46))
    lines.line(to: NSPoint(x: s * 0.75, y: s * 0.34))
    lines.stroke()
    for (x, y) in [(0.5, 0.75), (0.25, 0.25), (0.75, 0.25)] {
        let node = NSBezierPath(roundedRect: NSRect(x: s * (x - 0.095), y: s * (y - 0.085), width: s * 0.19, height: s * 0.17), xRadius: s * 0.025, yRadius: s * 0.025)
        node.lineWidth = lines.lineWidth
        node.stroke()
    }
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}
for size in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let suffix = scale == 2 ? "@2x" : ""
        try render(size * scale, tray: false).write(to: URL(fileURLWithPath: "\(destination)/App.iconset/icon_\(size)x\(size)\(suffix).png"))
    }
}
try render(36, tray: true).write(to: URL(fileURLWithPath: destination + "/tray.png"))

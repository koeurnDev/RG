import AppKit
// Recreate the original app icon with macOS drawing APIs: swift scripts/create-icon.swift
let size = 1024
let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
let tile = NSBezierPath(roundedRect: NSRect(x: 72, y: 72, width: 880, height: 880), xRadius: 196, yRadius: 196)
let gradient = NSGradient(starting: NSColor(srgbRed: 0.98, green: 0.37, blue: 0.30, alpha: 1), ending: NSColor(srgbRed: 0.85, green: 0.19, blue: 0.17, alpha: 1))!
gradient.draw(in: tile, angle: -90)
let play = NSBezierPath()
play.move(to: NSPoint(x: 410, y: 299))
play.curve(to: NSPoint(x: 373, y: 321), controlPoint1: NSPoint(x: 392, y: 289), controlPoint2: NSPoint(x: 373, y: 299))
play.line(to: NSPoint(x: 373, y: 703))
play.curve(to: NSPoint(x: 410, y: 725), controlPoint1: NSPoint(x: 373, y: 725), controlPoint2: NSPoint(x: 392, y: 735))
play.line(to: NSPoint(x: 721, y: 534))
play.curve(to: NSPoint(x: 721, y: 490), controlPoint1: NSPoint(x: 740, y: 523), controlPoint2: NSPoint(x: 740, y: 501))
play.close()
NSColor.white.setFill()
play.fill()
NSGraphicsContext.restoreGraphicsState()
try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: "build/icon.png"))
print("Created build/icon.png (1024 × 1024)")

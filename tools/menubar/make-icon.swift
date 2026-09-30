//
//  Renders the app icon: the Volk logo on the macOS rounded-square plate.
//
//  The source PNG is a circle on a full black square. Used as is, macOS draws
//  it edge to edge with sharp corners, unlike every other icon in Launchpad, so
//  it is placed on the standard 824 pt plate inside a 1024 canvas.
//
//  swift make-icon.swift <logo.png> <out.png>
//

import AppKit

let args = CommandLine.arguments
guard args.count == 3, let logo = NSImage(contentsOfFile: args[1]) else {
    FileHandle.standardError.write("uso: make-icon <logo.png> <out.png>\n".data(using: .utf8)!)
    exit(1)
}

let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 1024, pixelsHigh: 1024,
                           bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                           colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)

let plate = NSBezierPath(roundedRect: NSRect(x: 100, y: 100, width: 824, height: 824),
                         xRadius: 185, yRadius: 185)
NSColor(white: 0.05, alpha: 1).setFill()
plate.fill()
plate.addClip()
logo.draw(in: NSRect(x: 150, y: 150, width: 724, height: 724))

NSGraphicsContext.current = nil
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: args[2]))

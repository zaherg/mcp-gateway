#import <AppKit/AppKit.h>

static NSButton *statusButton(NSView *view) {
    if ([NSStringFromClass([view class]) isEqualToString:@"NSStatusBarButton"])
        return (NSButton *)view;
    for (NSView *child in view.subviews) {
        NSButton *found = statusButton(child);
        if (found) return found;
    }
    return nil;
}

// Replaces the status item's image with the glyph at `path`: a template image when
// stopped, or a non-template image with a green dot when running. The running image
// draws the glyph in labelColor at draw time, so it follows the menu bar's light or
// dark appearance as a template does. A template cannot carry the dot's color, and
// Electrobun's setTrayImage clears the template flag, so the image is set natively.
// Returns 0 on success, -1 for invalid arguments, -2 when the glyph cannot be loaded,
// -3 when the status button is not found.
__attribute__((visibility("default"))) int mcp_tray_set_running(const char *path, double size, int running) {
    if (path == NULL || !(size > 0)) return -1;
    __block int result = -3;
    void (^apply)(void) = ^{
        NSImage *glyph = [[NSImage alloc] initWithContentsOfFile:[NSString stringWithUTF8String:path]];
        if (!glyph) { result = -2; return; }
        NSSize extent = NSMakeSize(size, size);
        glyph.size = extent;
        NSImage *image = glyph;
        if (running) {
            image = [NSImage imageWithSize:extent flipped:NO drawingHandler:^BOOL(NSRect bounds) {
                [glyph drawInRect:bounds];
                [NSColor.labelColor set];
                NSRectFillUsingOperation(bounds, NSCompositingOperationSourceIn);
                // A transparent gap around the dot keeps it distinct from the glyph.
                CGFloat diameter = bounds.size.width * 0.32;
                CGFloat gap = bounds.size.width * 0.06;
                NSRect dot = NSMakeRect(NSMaxX(bounds) - diameter,
                    NSMinY(bounds), diameter, diameter);
                [[NSGraphicsContext currentContext] saveGraphicsState];
                [[NSGraphicsContext currentContext] setCompositingOperation:NSCompositingOperationClear];
                [[NSBezierPath bezierPathWithOvalInRect:NSInsetRect(dot, -gap, -gap)] fill];
                [[NSGraphicsContext currentContext] restoreGraphicsState];
                [[NSColor colorWithSRGBRed:0.18 green:0.8 blue:0.35 alpha:1] setFill];
                [[NSBezierPath bezierPathWithOvalInRect:dot] fill];
                return YES;
            }];
        }
        image.template = !running;
        for (NSWindow *window in NSApp.windows) {
            NSButton *button = statusButton(window.contentView);
            if (!button) continue;
            button.image = image;
            result = 0;
            return;
        }
    };
    if ([NSThread isMainThread]) apply();
    else dispatch_sync(dispatch_get_main_queue(), apply);
    return result;
}

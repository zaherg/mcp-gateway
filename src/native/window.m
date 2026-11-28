#import <AppKit/AppKit.h>

static NSColor *mcpWindowBackgroundColor(void) {
    return [NSColor colorWithName:nil
                  dynamicProvider:^NSColor *(NSAppearance *appearance) {
                      NSAppearanceName match = [appearance bestMatchFromAppearancesWithNames:@[
                          NSAppearanceNameAqua,
                          NSAppearanceNameDarkAqua,
                      ]];
                      if ([match isEqualToString:NSAppearanceNameDarkAqua]) {
                          return [NSColor colorWithSRGBRed:0x1e / 255.0
                                                     green:0x20 / 255.0
                                                      blue:0x23 / 255.0
                                                     alpha:1.0];
                      }
                      return [NSColor whiteColor];
                  }];
}

// Applies a matching window background, minimum content size, and frame autosave name to the
// NSWindow whose address matches `pointer`. The address is only compared against NSApp.windows,
// never dereferenced, so a pointer that is not an NSWindow is refused instead of crashing.
// Returns 0 on success, -1 for invalid arguments, -2 when no window matches.
__attribute__((visibility("default"))) int mcp_window_set_min_content_size(
    void *pointer, double width, double height) {
    if (pointer == NULL || !(width > 0) || !(height > 0)) return -1;
    __block int result = -2;
    void (^apply)(void) = ^{
        for (NSWindow *window in NSApp.windows) {
            if ((__bridge void *)window != pointer) continue;
            window.backgroundColor = mcpWindowBackgroundColor();
            window.contentMinSize = NSMakeSize(width, height);
            [window setFrameAutosaveName:@"MCPGatewayMainWindow"];
            NSSize contentSize = [window contentRectForFrameRect:window.frame].size;
            if (contentSize.width < width || contentSize.height < height) {
                [window setContentSize:NSMakeSize(MAX(contentSize.width, width),
                                                  MAX(contentSize.height, height))];
            }
            result = 0;
            return;
        }
    };
    if ([NSThread isMainThread]) apply();
    else dispatch_sync(dispatch_get_main_queue(), apply);
    return result;
}

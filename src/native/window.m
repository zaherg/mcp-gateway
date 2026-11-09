#import <AppKit/AppKit.h>

// Applies a minimum content size to the NSWindow whose address matches `pointer`.
// The address is only compared against NSApp.windows, never dereferenced, so a
// pointer that is not an NSWindow is refused instead of crashing.
// Returns 0 on success, -1 for invalid arguments, -2 when no window matches.
__attribute__((visibility("default"))) int mcp_window_set_min_content_size(
    void *pointer, double width, double height) {
    if (pointer == NULL || !(width > 0) || !(height > 0)) return -1;
    __block int result = -2;
    void (^apply)(void) = ^{
        for (NSWindow *window in NSApp.windows) {
            if ((__bridge void *)window != pointer) continue;
            window.contentMinSize = NSMakeSize(width, height);
            result = 0;
            return;
        }
    };
    if ([NSThread isMainThread]) apply();
    else dispatch_sync(dispatch_get_main_queue(), apply);
    return result;
}

#import <AppKit/AppKit.h>

// Called only by the opt-in isolated smoke path. Exercise Cocoa's real menu
// shortcut dispatch without posting global keyboard input or requesting Accessibility.
__attribute__((visibility("default"))) void mcp_test_quit_shortcut(void) {
    dispatch_async(dispatch_get_main_queue(), ^{
        NSApplication *app = [NSApplication sharedApplication];
        NSEvent *event = [NSEvent keyEventWithType:NSEventTypeKeyDown
            location:NSZeroPoint
            modifierFlags:NSEventModifierFlagCommand
            timestamp:[NSProcessInfo processInfo].systemUptime
            windowNumber:app.keyWindow.windowNumber
            context:nil
            characters:@"q"
            charactersIgnoringModifiers:@"q"
            isARepeat:NO
            keyCode:12];
        // Queue delivery after this block returns, so shutdown cannot unload
        // this library while a probe callback is still executing inside it.
        [app postEvent:event atStart:NO];
    });
}

__attribute__((visibility("default"))) void mcp_test_close_shortcut(void) {
    dispatch_async(dispatch_get_main_queue(), ^{
        NSApplication *app = [NSApplication sharedApplication];
        NSEvent *event = [NSEvent keyEventWithType:NSEventTypeKeyDown
            location:NSZeroPoint
            modifierFlags:NSEventModifierFlagCommand
            timestamp:[NSProcessInfo processInfo].systemUptime
            windowNumber:app.keyWindow.windowNumber
            context:nil
            characters:@"w"
            charactersIgnoringModifiers:@"w"
            isARepeat:NO
            keyCode:13];
        // Queue delivery after this block returns, so shutdown cannot unload
        // this library while a probe callback is still executing inside it.
        [app postEvent:event atStart:NO];
    });
}

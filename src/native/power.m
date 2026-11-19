#import <Foundation/Foundation.h>

__attribute__((visibility("default"))) void *mcp_begin_idle_sleep_assertion(void) {
    @autoreleasepool {
        id activity = [[NSProcessInfo processInfo] beginActivityWithOptions:NSActivityIdleSystemSleepDisabled
                                                                    reason:@"MCP Gateway is listening for clients"];
        return (__bridge_retained void *)activity;
    }
}

__attribute__((visibility("default"))) void mcp_end_idle_sleep_assertion(void *activity) {
    @autoreleasepool {
        [[NSProcessInfo processInfo] endActivity:(__bridge_transfer id)activity];
    }
}

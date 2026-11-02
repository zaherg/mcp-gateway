#import <Foundation/Foundation.h>
#import <ServiceManagement/ServiceManagement.h>

// These functions run inside the signed app process, not a separate helper bundle.
// Fixed integer results prevent NSError details from reaching renderer/log output.
static BOOL isGatewayBundle(void) {
    return [[[NSBundle mainBundle] bundleIdentifier] isEqualToString:@"dev.srvr.mcpgateway"];
}

__attribute__((visibility("default"))) int mcp_login_status(void) {
    @autoreleasepool {
        if (!isGatewayBundle()) return -1;
        if (@available(macOS 13.0, *)) {
            return (int)[SMAppService mainAppService].status;
        }
        return -1;
    }
}

__attribute__((visibility("default"))) int mcp_login_set(int enabled) {
    @autoreleasepool {
        if (!isGatewayBundle()) return -1;
        if (@available(macOS 13.0, *)) {
            SMAppService *service = [SMAppService mainAppService];
            if (enabled && service.status == SMAppServiceStatusEnabled) return 0;
            if (!enabled && service.status == SMAppServiceStatusNotRegistered) return 0;
            NSError *error = nil;
            BOOL success = enabled ? [service registerAndReturnError:&error]
                                   : [service unregisterAndReturnError:&error];
            return success ? 0 : 1;
        }
        return -1;
    }
}

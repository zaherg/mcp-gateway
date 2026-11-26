#import <Foundation/Foundation.h>
#import <UserNotifications/UserNotifications.h>

__attribute__((visibility("default"))) int mcp_post_notification(
    const char *title_utf8,
    const char *body_utf8
) {
    @autoreleasepool {
        if (title_utf8 == NULL || body_utf8 == NULL) return -1;
        if ([NSBundle mainBundle].bundleIdentifier == nil) return -1;
        NSString *title = [NSString stringWithUTF8String:title_utf8];
        NSString *body = [NSString stringWithUTF8String:body_utf8];
        if (title == nil || body == nil) return -1;

        UNUserNotificationCenter *center = [UNUserNotificationCenter currentNotificationCenter];
        if (center == nil) return -1;

        UNAuthorizationOptions options = UNAuthorizationOptionAlert | UNAuthorizationOptionSound;
        [center requestAuthorizationWithOptions:options
                              completionHandler:^(BOOL granted, NSError * _Nullable error) {
            if (!granted || error != nil) return;
            UNMutableNotificationContent *content = [[UNMutableNotificationContent alloc] init];
            content.title = title;
            content.body = body;
            content.sound = [UNNotificationSound defaultSound];

            NSString *identifier = [[NSUUID UUID] UUIDString];
            UNNotificationRequest *request = [UNNotificationRequest requestWithIdentifier:identifier
                                                                                  content:content
                                                                                  trigger:nil];
            [center addNotificationRequest:request withCompletionHandler:nil];
        }];
        return 0;
    }
}

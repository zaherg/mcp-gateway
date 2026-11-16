#import <Foundation/Foundation.h>
#include <string.h>

// Copies the user's preferred languages (BCP 47 tags, most preferred first, separated by '\n')
// into `buffer` as NUL-terminated UTF-8. Returns the byte length without the NUL, -1 for invalid
// arguments, -2 when `capacity` is too small.
__attribute__((visibility("default"))) int mcp_preferred_languages(char *buffer, int capacity) {
    if (buffer == NULL || capacity <= 0) return -1;
    @autoreleasepool {
        NSString *joined = [[NSLocale preferredLanguages] componentsJoinedByString:@"\n"];
        const char *utf8 = joined.UTF8String;
        if (utf8 == NULL) return -1;
        size_t length = strlen(utf8);
        if (length >= (size_t)capacity) return -2;
        memcpy(buffer, utf8, length + 1);
        return (int)length;
    }
}

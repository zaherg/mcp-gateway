#import <Foundation/Foundation.h>
#include <signal.h>
#include <stdatomic.h>

// Only a signal-safe store runs in the handler. The SDK's dispatch sources still
// deliver Quit; their untagged callback reads this sticky intent before any UI gate.
_Static_assert(ATOMIC_INT_LOCK_FREE == 2, "Signal intent must be lock-free");
static atomic_int quitSignal = 0;
static void markQuitSignal(int value) {
    (void)value;
    atomic_store_explicit(&quitSignal, 1, memory_order_relaxed);
}

__attribute__((visibility("default"))) int mcp_quit_signal_install(void) {
    __block int result = 0;
    // Electrobun creates its sources before entering the main queue. Install here
    // so its SIG_IGN setup cannot later erase this observer.
    dispatch_sync(dispatch_get_main_queue(), ^{
        struct sigaction previousInt, previousTerm, observer = {0};
        if (sigaction(SIGINT, NULL, &previousInt) != 0 ||
            sigaction(SIGTERM, NULL, &previousTerm) != 0) { result = -1; return; }
        if (previousInt.sa_handler == markQuitSignal &&
            previousTerm.sa_handler == markQuitSignal) return;
        if (previousInt.sa_handler != SIG_IGN || previousTerm.sa_handler != SIG_IGN) {
            result = -1; return;
        }
        observer.sa_handler = markQuitSignal;
        observer.sa_flags = SA_RESTART;
        sigemptyset(&observer.sa_mask);
        if (sigaction(SIGINT, &observer, NULL) != 0) { result = -1; return; }
        if (sigaction(SIGTERM, &observer, NULL) != 0) {
            sigaction(SIGINT, &previousInt, NULL);
            result = -1;
        }
    });
    return result;
}

__attribute__((visibility("default"))) int mcp_quit_signal_requested(void) {
    return atomic_load_explicit(&quitSignal, memory_order_relaxed);
}

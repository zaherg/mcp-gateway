#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

int main(int argc, char **argv) {
    if (argc != 4 || access(argv[0], F_OK) != 0) return 2;
    if (unlink(argv[0]) != 0) return 3;
    const char *result = getenv("HELPER_RESULT");
    if (!result) return 4;
    FILE *out = fopen(result, "w");
    if (!out) return 5;
    fprintf(out, "{\"schema_version\":1,\"phase\":\"waiting_for_parent\"}\n");
    fclose(out);
    const char *ready = getenv("HELPER_READY");
    if (ready) {
        FILE *readyFile = fopen(ready, "w");
        if (readyFile) { fprintf(readyFile, "%d\n", getpid()); fclose(readyFile); }
    }
    for (;;) sleep(1);
}

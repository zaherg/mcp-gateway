#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

int main(int argc, char **argv) {
    if (argc != 4 || access(argv[0], F_OK) != 0) return 2;
    if (unlink(argv[0]) != 0) return 3;
    const char *marker = getenv("HELPER_READY");
    if (!marker) return 4;
    FILE *out = fopen(marker, "w");
    if (!out) return 5;
    fprintf(out, "%d\n", getpid());
    fclose(out);
    for (;;) sleep(1);
}

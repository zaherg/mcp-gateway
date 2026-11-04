#include <stdio.h>
#include <stdlib.h>

static void count(const char *name) {
  const char *path = getenv("MCP_LOGIN_COUNTER_PATH");
  if (!path) return;
  FILE *f = fopen(path, "a");
  if (!f) return;
  fprintf(f, "%s\n", name);
  fclose(f);
}

__attribute__((constructor)) static void onLoad(void) { count("load"); }
__attribute__((destructor)) static void onUnload(void) { count("unload"); }

int mcp_login_status(void) {
  count("status");
  return 1;
}

int mcp_login_set(int enabled) {
  count("set");
  (void)enabled;
  return 0;
}

void mcp_test_close_shortcut(void) {
  count("close-shortcut");
}

void mcp_test_quit_shortcut(void) {
  count("quit-shortcut");
}

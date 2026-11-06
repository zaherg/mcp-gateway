import { expect, test } from "bun:test";
import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { MAX_BACKEND_MESSAGE_BYTES } from "../../src/core/backend-output";
import { MAX_BACKEND_CALLS } from "../../src/core/backend-work";
import { MAX_CONFIG_BYTES } from "../../src/core/config";
import {
  MAX_BODY_BYTES,
  MAX_CONCURRENT_REQUESTS,
  MAX_REQUESTS_PER_MINUTE,
  REQUEST_DEADLINE_MS,
} from "../../src/core/ingress";
import { UPDATER_FEED_URL } from "../../src/main/updater/constants";

const mib = (bytes: number) => `${bytes / (1024 * 1024)} MiB`;

function section(markdown: string, title: string): string {
  const start = `## ${title}\n`;
  const body = markdown.split(start)[1];
  if (body === undefined) throw new Error(`Missing README section: ${title}`);
  return body.split("\n## ")[0];
}

test("README limits and update feed match the implementation", async () => {
  const readme = await readFile("README.md", "utf8");
  const security = section(readme, "Security");
  expect(security).toContain(`${MAX_CONCURRENT_REQUESTS} concurrent HTTP requests`);
  expect(security).toContain(`${MAX_REQUESTS_PER_MINUTE} admissions per minute`);
  expect(security).toContain(
    `${MAX_BACKEND_CALLS} backend calls can be in flight across all servers`,
  );
  expect(security).toContain(`backend HTTP response bodies are capped at ${mib(MAX_BODY_BYTES)}`);
  expect(security).toContain(`${mib(MAX_BACKEND_MESSAGE_BYTES)} per-event limit`);
  expect(security).toContain(`after ${REQUEST_DEADLINE_MS / 1000} seconds`);
  expect(MAX_BODY_BYTES).toBe(MAX_BACKEND_MESSAGE_BYTES);
  expect(section(readme, "Configuration")).toContain(`limited to ${mib(MAX_CONFIG_BYTES)}`);
  expect(section(readme, "Automatic updates")).toContain(`\`${UPDATER_FEED_URL}\``);
});

test("README and linked test guides have valid local links and anchors", async () => {
  const root = await realpath(".");
  for (const name of ["README.md", "tests/README.md", "tests/audit/README.md"]) {
    const file = resolve(name);
    const markdown = await readFile(file, "utf8");
    for (const match of markdown.matchAll(/(?<!!)\[[^\]]+\]\(([^)]+)\)/g)) {
      const target = match[1];
      if (/^[a-z][a-z\d+.-]*:/i.test(target) || target.startsWith("//")) continue;
      const [relativeTarget, anchor] = target.split("#", 2);
      const destination = relativeTarget
        ? resolve(dirname(file), decodeURIComponent(relativeTarget))
        : file;
      const canonical = await realpath(destination);
      const relativePath = relative(root, canonical);
      expect(
        relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath),
      ).toBe(false);
      const destinationText = await readFile(canonical, "utf8");
      if (anchor) {
        const headings = [...destinationText.matchAll(/^#{1,6} (.+)$/gm)].map((heading) =>
          heading[1]
            .toLowerCase()
            .replace(/[^\w\s-]/g, "")
            .trim()
            .replace(/\s+/g, "-"),
        );
        expect(headings).toContain(decodeURIComponent(anchor));
      }
    }
  }
});

test("test guide reports the later failed packaged acceptance", async () => {
  const guide = await readFile("tests/README.md", "utf8");
  expect(guide).toContain("the later required signed `late-start` test failed twice");
  expect(guide).not.toContain("acceptance passed for the final local `0.3.1` build");
});

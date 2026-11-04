import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ElectrobunConfig } from "electrobun";
import { createToolchainEnvironment } from "../../scripts/toolchain";
import { createCommandRunner } from "../../src/main/updater/verify";

const nativeTest = test.skipIf(process.platform !== "darwin" || process.arch !== "arm64");

nativeTest(
  "A4 identity gate: compiled executing build can be distinguished from resource copy",
  async () => {
    const project = resolve(".");
    const root = await mkdtemp(resolve(".cache/audit-identity-"));
    try {
      const records: Array<{ id: string; main: string; resource: string }> = [];
      for (const id of ["audit-build-a", "audit-build-b"]) {
        const directory = join(root, id);
        const home = join(directory, "home");
        await mkdir(home, { recursive: true, mode: 0o700 });
        await copyFile(join(project, "hutch.config.ts"), join(directory, "hutch.config.ts"));
        await writeFile(
          join(directory, "package.json"),
          JSON.stringify({ name: "audit-identity", version: "0.0.1", type: "module" }),
        );
        await writeFile(join(directory, "identity.json"), JSON.stringify({ build: id }));
        await writeFile(
          join(directory, "main.ts"),
          [
            'import { readFileSync } from "node:fs";',
            "declare const AUDIT_EXECUTING_ID: string;",
            'const supplied = JSON.parse(readFileSync(process.argv[2], "utf8"));',
            "console.log(JSON.stringify({ executing: AUDIT_EXECUTING_ID, resource: supplied.build, matches: AUDIT_EXECUTING_ID === supplied.build }));",
          ].join("\n"),
        );
        const config = {
          app: { name: "Audit Identity", identifier: "dev.srvr.auditidentity", version: "0.0.1" },
          build: {
            buildFolder: "build",
            artifactFolder: "artifacts",
            mainProcess: "bun",
            bun: { entrypoint: "main.ts", define: { AUDIT_EXECUTING_ID: JSON.stringify(id) } },
            copy: { "identity.json": "identity.json" },
            mac: { bundleCEF: false, codesign: false, notarize: false, createDmg: false },
          },
        } satisfies ElectrobunConfig;
        await writeFile(
          join(directory, "electrobun.config.ts"),
          `export default ${JSON.stringify(config)};\n`,
        );
        const env = createToolchainEnvironment(process.platform, process.arch, {
          PATH: process.env.PATH,
          HOME: home,
        });
        const run = createCommandRunner((command, args) =>
          spawn(command, [...args], {
            cwd: directory,
            env,
            shell: false,
            stdio: ["ignore", "pipe", "pipe"],
          }),
        );
        const result = await run(
          "node",
          [join(project, "node_modules/electrobun/bin/electrobun.cjs"), "build", "--env=dev"],
          120_000,
        );
        await writeFile(join(directory, "build.log"), `${result.stdout}\n${result.stderr}`, {
          mode: 0o600,
        });
        expect(result.exitCode).toBe(0);
        const files = await readdir(join(directory, "build"), { recursive: true });
        const resource = files.find((path) =>
          path.endsWith("/Contents/Resources/app/identity.json"),
        );
        const mains = files.filter(
          (path) => path.endsWith(".js") && path.includes("/Contents/Resources/app/"),
        );
        let main: string | undefined;
        for (const path of mains) {
          if ((await readFile(join(directory, "build", path), "utf8")).includes(id)) {
            expect(main).toBeUndefined();
            main = join(directory, "build", path);
          }
        }
        if (!resource || !main)
          throw new Error(`Identity define/copy output missing: ${directory}`);
        records.push({ id, main, resource: join(directory, "build", resource) });
      }
      const run = createCommandRunner();
      const observations: unknown[] = [];
      for (const executing of records)
        for (const resource of records) {
          const result = await run(process.execPath, [executing.main, resource.resource], 10_000);
          expect(result.exitCode).toBe(0);
          expect(result.stderr).toBe("");
          const actual: unknown = JSON.parse(result.stdout);
          const expected = {
            executing: executing.id,
            resource: resource.id,
            matches: executing.id === resource.id,
          };
          expect(actual).toEqual(expected);
          observations.push(actual);
        }
      await writeFile(
        join(root, "verification.json"),
        JSON.stringify(
          { sourceGate: "A4", root, observations, signed: false, installed: false },
          null,
          2,
        ),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  300_000,
);

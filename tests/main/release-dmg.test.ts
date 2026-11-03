import { expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { withDmgMount } from "../../scripts/release-dmg";
import type { CommandRunner } from "../../src/main/updater/verify";

async function fixture() {
  await mkdir(resolve(".cache"), { recursive: true });
  const root = await mkdtemp(resolve(".cache/release-dmg-test-"));
  const image = join(root, "test.dmg");
  await writeFile(image, "synthetic");
  let mount = "";
  let mounted = false;
  let imagePath = image;
  let mountSuffix = "";
  let attachCode = 0;
  let detachCode = 0;
  let unknown = false;
  let beforeAttach: (() => Promise<void>) | undefined;
  const calls: string[][] = [];
  const run: CommandRunner = async (command, args, timeout, signal) => {
    expect(timeout).toBeGreaterThan(0);
    calls.push([command, ...args]);
    if (args[0] === "attach") {
      // Cancellation must not lose a mount that appears after the signal.
      expect(signal).toBeUndefined();
      mount = args[args.indexOf("-mountpoint") + 1] ?? "";
      await beforeAttach?.();
      mounted = true;
      return { exitCode: attachCode, stdout: "", stderr: "" };
    }
    if (args[0] === "detach") {
      expect(args.at(-1)).toBe(mount);
      if (detachCode === 0 || args.includes("-force")) mounted = false;
      return { exitCode: args.includes("-force") ? 0 : detachCode, stdout: "", stderr: "" };
    }
    if (args[0] === "info") {
      if (unknown) throw new Error("inspection timeout");
      expect(args).toEqual(["info", "-plist"]);
      return { exitCode: 0, stdout: "<plist/>", stderr: "" };
    }
    expect(command).toBe("/usr/bin/plutil");
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        images: mounted
          ? [
              {
                "image-path": imagePath,
                "system-entities": [
                  { "mount-point": mount + mountSuffix, "dev-entry": "/dev/disk99s1" },
                ],
              },
            ]
          : [],
      }),
      stderr: "",
    };
  };
  return {
    root,
    image,
    run,
    calls,
    mount: () => mount,
    set: (options: {
      attachCode?: number;
      detachCode?: number;
      imagePath?: string;
      mountSuffix?: string;
      unknown?: boolean;
      beforeAttach?: () => Promise<void>;
    }) => {
      attachCode = options.attachCode ?? attachCode;
      detachCode = options.detachCode ?? detachCode;
      imagePath = options.imagePath ?? imagePath;
      mountSuffix = options.mountSuffix ?? mountSuffix;
      unknown = options.unknown ?? unknown;
      beforeAttach = options.beforeAttach ?? beforeAttach;
    },
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

for (const fails of [false, true]) {
  test(`detaches and confirms absence after verification ${fails ? "failure" : "success"}`, async () => {
    const f = await fixture();
    try {
      const result = withDmgMount(
        f.image,
        f.root,
        async () => {
          if (fails) throw new Error("inventory differs");
          return 42;
        },
        { run: f.run },
      );
      if (fails) await expect(result).rejects.toThrow("inventory differs");
      else expect(await result).toBe(42);
      expect(f.calls.filter((args) => args[1] === "detach")).toHaveLength(1);
      expect(await readdir(f.root)).toEqual(["test.dmg"]);
    } finally {
      await f.dispose();
    }
  });
}

test("preserves rejection even when a verifier throws a non-Error value", async () => {
  const f = await fixture();
  try {
    let rejected = false;
    await withDmgMount(f.image, f.root, () => Promise.reject(undefined), { run: f.run }).then(
      () => {
        throw new Error("Verification rejection was swallowed.");
      },
      (error: unknown) => {
        rejected = true;
        expect(error).toBeUndefined();
      },
    );
    expect(rejected).toBe(true);
    expect(await readdir(f.root)).toEqual(["test.dmg"]);
  } finally {
    await f.dispose();
  }
});

test("cancellation waits for in-flight attach, then detaches the late mount", async () => {
  const f = await fixture();
  const abort = new AbortController();
  let settle!: () => void;
  let entered!: () => void;
  const attaching = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.set({
    beforeAttach: () => {
      entered();
      return new Promise<void>((resolve) => {
        settle = resolve;
      });
    },
  });
  let callback = false;
  let finished = false;
  try {
    const operation = withDmgMount(
      f.image,
      f.root,
      async () => {
        callback = true;
      },
      { run: f.run, signal: abort.signal },
    );
    const observed = operation.catch((error: unknown) => {
      finished = true;
      return error;
    });
    await attaching;
    abort.abort();
    await Bun.sleep(10);
    expect(finished).toBe(false);
    expect(f.calls.some((args) => args[1] === "detach")).toBe(false);
    settle();
    expect(await observed).toBeInstanceOf(Error);
    expect(callback).toBe(false);
    expect(f.calls.filter((args) => args[1] === "detach")).toHaveLength(1);
    expect(await readdir(f.root)).toEqual(["test.dmg"]);
  } finally {
    settle?.();
    await f.dispose();
  }
});

test("failed attach cleans a discovered mount but retains uncertain ownership evidence", async () => {
  const f = await fixture();
  f.set({ attachCode: 1 });
  try {
    await expect(withDmgMount(f.image, f.root, async () => {}, { run: f.run })).rejects.toThrow(
      "unconfirmed",
    );
    expect(f.calls.filter((args) => args[1] === "detach")).toHaveLength(1);
    await access(f.mount());
  } finally {
    await f.dispose();
  }
});

test("force detach is restricted to an exactly re-inspected owned mount", async () => {
  const f = await fixture();
  f.set({ detachCode: 1 });
  try {
    await withDmgMount(f.image, f.root, async () => {}, { run: f.run });
    expect(f.calls.filter((args) => args[1] === "detach")).toEqual([
      ["/usr/bin/hdiutil", "detach", f.mount()],
      ["/usr/bin/hdiutil", "detach", "-force", f.mount()],
    ]);
  } finally {
    await f.dispose();
  }
});

test("does not confuse an unrelated prefix-sharing mount with the owned mount", async () => {
  const f = await fixture();
  f.set({ mountSuffix: "-unrelated" });
  try {
    await expect(withDmgMount(f.image, f.root, async () => {}, { run: f.run })).rejects.toThrow(
      "did not establish",
    );
    expect(f.calls.some((args) => args[1] === "detach")).toBe(false);
  } finally {
    await f.dispose();
  }
});

test("retains ownership when post-detach inspection cannot confirm absence", async () => {
  const f = await fixture();
  const run: CommandRunner = async (...args) => {
    const result = await f.run(...args);
    if (args[1][0] === "detach") f.set({ unknown: true });
    return result;
  };
  try {
    await expect(withDmgMount(f.image, f.root, async () => {}, { run })).rejects.toThrow(
      "unconfirmed",
    );
    await access(f.mount());
  } finally {
    await f.dispose();
  }
});

test("an attach command timeout never implies a settled absent mount", async () => {
  const f = await fixture();
  f.set({
    beforeAttach: async () => {
      throw new Error("command timed out");
    },
  });
  try {
    await expect(withDmgMount(f.image, f.root, async () => {}, { run: f.run })).rejects.toThrow(
      "unconfirmed",
    );
    await access(f.mount());
  } finally {
    await f.dispose();
  }
});

for (const options of [{ unknown: true }, { imagePath: "/different/test.dmg" }]) {
  test(`does not detach or remove a mount with ${options.unknown ? "unknown" : "foreign"} identity`, async () => {
    const f = await fixture();
    f.set(options);
    try {
      await expect(withDmgMount(f.image, f.root, async () => {}, { run: f.run })).rejects.toThrow();
      expect(f.calls.some((args) => args[1] === "detach")).toBe(false);
      await access(f.mount());
    } finally {
      await f.dispose();
    }
  });
}

import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';

import type { ChildrenOwner, GatewayLogger } from '@mcp-gateway/core/sessions';

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type CommandRunner = (
  command: string,
  args: readonly string[],
  timeoutMs?: number,
  signal?: AbortSignal,
) => Promise<CommandResult>;

const SAFE_PARENT_ENV_KEYS = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'TMPDIR',
  'TERM',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  '__CF_USER_TEXT_ENCODING',
]);

export const isBlockedEnvironmentKey = (key: string) => {
  const upper = key.toUpperCase();
  return (
    upper === 'NODE_OPTIONS' ||
    upper === 'BUN_OPTIONS' ||
    upper.startsWith('DYLD_') ||
    upper.startsWith('LD_')
  );
};

export const isAllowedParentEnvironmentKey = (key: string) =>
  SAFE_PARENT_ENV_KEYS.has(key) || key.startsWith('LC_') || key.startsWith('XDG_');

export const childEnvironment = (
  serverEnv?: Readonly<Record<string, string>>,
  parentEnv = process.env,
) => {
  const merged: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(parentEnv)) {
    if (
      typeof value === 'string' &&
      isAllowedParentEnvironmentKey(key) &&
      !isBlockedEnvironmentKey(key)
    ) {
      merged[key] = value;
    }
  }
  if (serverEnv) {
    for (const [key, value] of Object.entries(serverEnv)) {
      if (typeof value === 'string' && !isBlockedEnvironmentKey(key)) {
        merged[key] = value;
      }
    }
  }
  return merged;
};

interface CreateCommandRunnerOptions {
  defaultTimeoutMs?: number;
  maxOutputBytes?: number;
  /** Replaces the inherited environment of every command this runner starts. */
  env?: NodeJS.ProcessEnv;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
const DEFAULT_COMMAND_OUTPUT_BYTES = 64 * 1024;

export const createCommandRunner = (options?: CreateCommandRunnerOptions): CommandRunner => {
  const defaultTimeoutMs = options?.defaultTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const maxOutputBytes = options?.maxOutputBytes ?? DEFAULT_COMMAND_OUTPUT_BYTES;
  for (const limit of [defaultTimeoutMs, maxOutputBytes]) {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('Invalid command limit');
  }
  return (command, args, timeoutMs = defaultTimeoutMs, signal) =>
    new Promise((resolvePromise, reject) => {
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
        reject(new Error('Invalid command deadline'));
        return;
      }
      if (signal?.aborted) {
        reject(new Error('Command cancelled'));
        return;
      }

      const child = spawn(command, [...args], {
        env: options?.env,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      let termination: Error | undefined;
      let abortHandler: (() => void) | undefined;

      const finish = (result: CommandResult | Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (abortHandler) signal?.removeEventListener('abort', abortHandler);
        if (result instanceof Error) reject(result);
        else resolvePromise(result);
      };

      const terminate = (error: Error) => {
        if (settled || termination) return;
        termination = error;
        try {
          child.kill('SIGKILL');
        } catch (failure) {
          termination =
            failure instanceof Error ? failure : new Error('Command termination failed');
        }
        // Ownership stays unsettled until close, even if termination is unconfirmed.
      };

      const timer = setTimeout(() => terminate(new Error('Command timed out')), timeoutMs);

      abortHandler = () => terminate(new Error('Command cancelled'));

      child.stdout?.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes <= maxOutputBytes) stdout.push(chunk);
        else terminate(new Error('Command output exceeded the limit'));
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.byteLength;
        if (stderrBytes <= maxOutputBytes) stderr.push(chunk);
        else terminate(new Error('Command output exceeded the limit'));
      });

      child.on('error', (error) => {
        if (child.pid === undefined) finish(error);
        else terminate(error);
      });

      child.on('close', (code) => {
        if (termination) {
          finish(termination);
          return;
        }
        if (stdoutBytes > maxOutputBytes || stderrBytes > maxOutputBytes) {
          finish(new Error('Command output exceeded the limit'));
          return;
        }
        finish({
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          exitCode: code ?? -1,
        });
      });
      signal?.addEventListener('abort', abortHandler, { once: true });
      if (signal?.aborted) terminate(new Error('Command cancelled'));
    });
};

export const runCommand = createCommandRunner();

interface GroupMember {
  pid: number;
  start: string;
}
type BackendGroup =
  | { status: 'absent' }
  | { status: 'unknown' }
  | { status: 'present'; members: GroupMember[] };

const runInspection = createCommandRunner({ defaultTimeoutMs: 2_000, maxOutputBytes: 16 * 1024 });

const inspectBackendGroup = async (pgid: number): Promise<BackendGroup> => {
  try {
    const listed = await runInspection('/usr/bin/pgrep', ['-g', String(pgid)]);
    if (listed.exitCode === 1 && !listed.stdout.trim() && !listed.stderr.trim())
      return { status: 'absent' };
    if (listed.exitCode !== 0 || listed.stderr.trim()) return { status: 'unknown' };
    const ids = listed.stdout.trim().split(/\s+/);
    if (
      !ids.length ||
      ids.length > 128 ||
      ids.some((id) => !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)))
    )
      return { status: 'unknown' };
    const inspected = await runInspection('/bin/ps', [
      '-p',
      ids.join(','),
      '-o',
      'pid=',
      '-o',
      'pgid=',
      '-o',
      'uid=',
      '-o',
      'lstart=',
    ]);
    if (inspected.exitCode !== 0 || inspected.stderr.trim()) return { status: 'unknown' };
    const members: GroupMember[] = [];
    for (const line of inspected.stdout.trim().split('\n')) {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
      if (
        !match ||
        !ids.includes(match[1] ?? '') ||
        Number(match[2]) !== pgid ||
        Number(match[3]) !== process.getuid?.() ||
        !match[4]
      )
        return { status: 'unknown' };
      members.push({ pid: Number(match[1]), start: match[4] });
    }
    if (members.length !== ids.length || new Set(members.map(({ pid }) => pid)).size !== ids.length)
      return { status: 'unknown' };
    return { status: 'present', members };
  } catch {
    return { status: 'unknown' };
  }
};

// Signal 0 checks existence without spawning pgrep; ESRCH means no process is
// left in the group. Any other answer falls through to the identity inspection.
const groupGone = (pgid: number) => {
  try {
    process.kill(-pgid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
};

// macOS assigns process IDs in increasing order and reuses one only after the counter
// wraps at 99,999, so a group present this soon after its leader exited is still ours.
const EXIT_TRUST_MS = 1_000;
const TERMINATION_GRACE_MS = 5_000;
const TERMINATION_POLL_MS = 50;
// Unconfirmed groups are only inspected, so a fast poll would waste CPU forever.
const STUCK_POLL_MS = 1_000;

/** A cleanup stays owned through uncertain inspection or refused termination. */
export class BackendProcesses implements ChildrenOwner {
  closing = false;
  readonly spawnOptions = { shell: false, detached: true };
  private readonly stops = new Set<() => Promise<void>>();

  constructor(private readonly logger: GatewayLogger) {}

  track(stop: () => Promise<void>) {
    let operation: Promise<void> | undefined;
    const once = () =>
      (operation ??= Promise.resolve()
        .then(stop)
        .then(() => {
          this.stops.delete(once);
        }));
    this.stops.add(once);
    return once;
  }

  own(child: ChildProcess) {
    const pid = child.pid;
    const running = () => child.exitCode === null && child.signalCode === null;
    // Set only when this owner saw the exit happen.
    let exitedAt: number | undefined;
    const exited = new Promise<void>((resolve) => {
      if (!running()) resolve();
      else {
        child.once('exit', () => {
          exitedAt = Date.now();
          resolve();
        });
        child.once('close', resolve);
      }
    });
    let known = new Map<number, string>();
    const remember = (state: BackendGroup) => {
      if (state.status !== 'present') return false;
      // A helper started after registration is unknown, so the first inspection after the
      // leader's exit records it; later inspections then trust it through `known`.
      const trusted = running()
        ? state.members.some((member) => member.pid === pid)
        : (exitedAt !== undefined && Date.now() - exitedAt < EXIT_TRUST_MS) ||
          state.members.some((member) => known.get(member.pid) === member.start);
      if (trusted) known = new Map(state.members.map(({ pid, start }) => [pid, start]));
      return trusted;
    };
    // Capture while the ChildProcess still proves the leader's identity.
    const registration =
      pid === undefined
        ? Promise.resolve()
        : inspectBackendGroup(pid).then((state) => {
            remember(state);
          });
    const stop = this.track(async () => {
      await registration;
      if (pid === undefined) {
        await exited;
        return;
      }
      const deadline = Date.now() + TERMINATION_GRACE_MS;
      let reported = false;
      // One TERM starts the grace period; repeating it makes many backends force-quit.
      let termSent = false;
      for (;;) {
        if (groupGone(pid)) {
          await exited;
          return;
        }
        const state = await inspectBackendGroup(pid);
        if (state.status === 'absent') {
          await exited;
          return;
        }
        if (remember(state)) {
          const graceful = Date.now() < deadline;
          try {
            if (!graceful) process.kill(-pid, 'SIGKILL');
            else if (!termSent) {
              process.kill(-pid, 'SIGTERM');
              termSent = true;
            }
          } catch (error) {
            // ESRCH is rechecked, and EPERM never means successful termination.
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH' && !reported) {
              reported = true;
              this.logger.error('Backend process-group termination is unconfirmed.');
            }
          }
        } else if (!reported) {
          reported = true;
          this.logger.error(
            'Backend process-group identity could not be confirmed; cleanup remains pending.',
          );
        }
        await new Promise<void>((resolve) =>
          setTimeout(resolve, Date.now() < deadline ? TERMINATION_POLL_MS : STUCK_POLL_MS),
        );
      }
    });
    const stopOnExit = () => {
      void stop().catch((error: unknown) => this.logger.error(error));
    };
    child.once('exit', stopOnExit);
    child.once('error', stopOnExit);
    return stop;
  }

  async close() {
    this.closing = true;
    while (this.stops.size) await Promise.all([...this.stops].map((stop) => stop()));
  }
}

import { type ChildProcess, spawn } from 'node:child_process';

interface RunCliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export const runCli = (
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<RunCliResult> =>
  new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(
        new Error(
          `runCli timed out after ${options.timeoutMs ?? 60_000}ms: ${command} ${args.join(' ')}\nstderr:\n${stderr}`,
        ),
      );
    }, options.timeoutMs ?? 60_000);
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });

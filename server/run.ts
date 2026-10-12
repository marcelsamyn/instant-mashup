export class CommandError extends Error {
  constructor(
    readonly command: string,
    readonly exitCode: number,
    readonly stderr: string,
  ) {
    super(`${command} exited with ${exitCode}: ${stderr.trim().split("\n").slice(-3).join(" | ")}`);
  }
}

/** Run a command and return its stdout. Throws CommandError with the stderr tail on failure. */
export async function run(cmd: string[], opts: { cwd?: string } = {}): Promise<string> {
  const proc = Bun.spawn(cmd, { cwd: opts.cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) throw new CommandError(cmd[0] ?? "command", exitCode, stderr);
  return stdout;
}

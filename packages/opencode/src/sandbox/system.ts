import type { Deps } from "./types"

// Real system access. The Landlock launcher is not part of this skeleton, so the ABI probe reports it as missing.
export const systemDeps: Deps = {
  platform: process.platform,
  execPath: process.execPath,
  which: (command) => Bun.which(command) ?? undefined,
  run: async (file, args, timeoutMs) => {
    const child = Bun.spawn([file, ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" })
    const timer = setTimeout(() => child.kill(), timeoutMs)
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      return { code, stdout, stderr }
    } finally {
      clearTimeout(timer)
    }
  },
  landlockAbi: async () => ({ error: "launcher", detail: "the Landlock launcher subcommand is not implemented" }),
}

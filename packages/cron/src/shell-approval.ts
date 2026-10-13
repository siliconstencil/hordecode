// Shell commands that a user approved through the permission system in this process.
// The set lives in memory only, so a task file in a repository can never mark its own
// command as approved; a command read from disk runs only after the same command was
// scheduled through the cron tool and approved in this process.
const approved = new Set<string>()

export const approveShell = (command: string) => {
  approved.add(command)
}

export const isShellApproved = (command: string) => approved.has(command)

import os from "os"
import { Global } from "@opencode-ai/global"
import { InstallationChannel, InstallationVersion } from "@opencode-ai/core/installation/version"
import { getInstallationID } from "@opencode-ai/core/util/installation-id"
import { HORDECODE_PROCESS_ROLE, HORDECODE_RUN_ID } from "./run-identity"

function username() {
  if (process.env.USER) return process.env.USER
  if (process.env.USERNAME) return process.env.USERNAME
  return os.userInfo().username
}

function locale() {
  return Intl.DateTimeFormat().resolvedOptions().locale
}

function timezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

export async function getEnvInfo() {
  const cpus = os.cpus()

  return {
    os: {
      platform: os.platform(),
      arch: os.arch(),
      release: os.release(),
      hostname: os.hostname(),
    },
    cpu: {
      model: cpus[0]?.model ?? "unknown",
      count: cpus.length,
    },
    memory: {
      total_bytes: os.totalmem(),
    },
    user: {
      username: username(),
      homedir: os.homedir(),
    },
    runtime: {
      bun_version: Bun.version,
      node_version: process.versions.node,
      pid: process.pid,
      timezone: timezone(),
      locale: locale(),
    },
    paths: {
      cwd: process.cwd(),
      data: Global.Path.data,
      config: Global.Path.config,
    },
    hordecode: {
      version: InstallationVersion,
      channel: InstallationChannel,
      installation_id: await getInstallationID(),
      run_id: HORDECODE_RUN_ID,
      process_role: HORDECODE_PROCESS_ROLE,
    },
  }
}

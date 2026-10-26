import { Server } from "@/server/server"
import { InstanceRuntime } from "@/project/instance-runtime"
import { Rpc } from "@/util/rpc"
import { upgrade } from "@/cli/upgrade"
import { Config } from "@/config/config"
import { GlobalBus } from "@/bus/global"
import { ServerAuth } from "@/server/auth"
import { writeHeapSnapshot } from "node:v8"
import { Heap } from "@/cli/heap"
import { AppRuntime } from "@/effect/app-runtime"
import { Effect } from "effect"
import { disposeAllInstancesAndEmitGlobalDisposed } from "@/server/global-lifecycle"
import { Log } from "@opencode-ai/core/util"
import { Installation } from "@/installation"

Heap.start()

// Worker has its own isolated module registry — Log.init on the main thread
// has no effect here. Re-initialize so Log.create() loggers write to file
// instead of stderr when --print-logs is not set.
await Log.init({
  print: process.env.OPENCODE_PRINT_LOGS === "1",
  dev: Installation.isLocal(),
  level: ((process.env.HORDECODE_LOG_LEVEL ?? process.env.OPENCODE_LOG_LEVEL) as Log.Level) ?? (Installation.isLocal() ? "DEBUG" : "INFO"),
})

const workerLog = Log.create({ service: "tui-worker" })

const onUnhandledRejection = (error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
  workerLog.error("unhandledRejection", { error: message })
}

const onUncaughtException = (error: Error) => {
  const message = error.stack ?? error.message
  workerLog.error("uncaughtException", { error: message })
}

process.on("unhandledRejection", onUnhandledRejection)
process.on("uncaughtException", onUncaughtException)

// Subscribe to global events and forward them via RPC
GlobalBus.on("event", (event) => {
  Rpc.emit("global.event", event)
})

let server: Awaited<ReturnType<typeof Server.listen>> | undefined

export const rpc = {
  async fetch(input: { url: string; method: string; headers: Record<string, string>; body?: string }) {
    const headers = { ...input.headers }
    const auth = ServerAuth.header()
    if (auth && !headers["authorization"] && !headers["Authorization"]) {
      headers["Authorization"] = auth
    }
    const request = new Request(input.url, {
      method: input.method,
      headers,
      body: input.body,
    })
    const response = await Server.Default().app.fetch(request)
    const body = await response.text()
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body,
    }
  },
  snapshot() {
    const result = writeHeapSnapshot("server.heapsnapshot")
    return result
  },
  async server(input: { port: number; hostname: string; mdns?: boolean; cors?: string[] }) {
    if (server) await server.stop(true)
    server = await Server.listen(input)
    return { url: server.url.toString() }
  },
  async checkUpgrade(input: { directory: string }) {
    await InstanceRuntime.load({ directory: input.directory })
    await upgrade().catch(() => {})
  },
  async reload() {
    await AppRuntime.runPromise(
      Effect.gen(function* () {
        const cfg = yield* Config.Service
        yield* cfg.invalidate()
        yield* disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true })
      }),
    )
  },
  async shutdown() {
    await InstanceRuntime.disposeAllInstances()
    if (server) await server.stop(true)
    process.off("unhandledRejection", onUnhandledRejection)
    process.off("uncaughtException", onUncaughtException)
  },
}

Rpc.listen(rpc)
// Tell the TUI thread the handler is installed; it holds its first call until then (cmd/tui.ts).
Rpc.emit("ready", true)

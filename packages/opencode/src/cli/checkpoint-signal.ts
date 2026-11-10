//  Exit on SIGINT/SIGTERM without throwing away a running checkpoint writer.
//
//  The one-shot `horde run` path installs these handlers while a prompt is
//  running: the first signal drains the in-flight checkpoint writers (bounded,
//  see CHECKPOINT_DRAIN_SIGNAL_TIMEOUT_MS), the second one leaves at once.
//  The user must never wait forever for a checkpoint, and a second Ctrl+C
//  must always exit immediately.
//
//  The drain itself is injected so this module stays free of the app runtime:
//  the caller owns the runtime that hosts the writers.

export const CHECKPOINT_DRAIN_SIGNAL_TIMEOUT_MS = 15_000

const EXIT_CODE: Record<string, number> = {
  SIGINT: 130,
  SIGTERM: 143,
}

export interface SignalEmitter {
  on(event: string, handler: () => void): unknown
  off(event: string, handler: () => void): unknown
}

export const installCheckpointDrainSignalHandlers = (options: {
  drain: () => Promise<unknown>
  exit?: (code: number) => void
  emitter?: SignalEmitter
}) => {
  const emitter = options.emitter ?? process
  const exit = options.exit ?? ((code: number) => process.exit(code))
  let signals = 0
  let exited = false

  const finish = (code: number) => {
    if (exited) return
    exited = true
    exit(code)
  }

  const handle = (signal: string) => {
    signals += 1
    if (signals > 1) {
      // The user asked a second time: leave now, the checkpoint is not worth
      // another second of waiting.
      finish(EXIT_CODE[signal] ?? 130)
      return
    }
    void Promise.resolve()
      .then(() => options.drain())
      .then(
        () => finish(EXIT_CODE[signal] ?? 130),
        () => finish(EXIT_CODE[signal] ?? 130),
      )
  }

  const onSigint = () => handle("SIGINT")
  const onSigterm = () => handle("SIGTERM")
  emitter.on("SIGINT", onSigint)
  emitter.on("SIGTERM", onSigterm)

  return () => {
    emitter.off("SIGINT", onSigint)
    emitter.off("SIGTERM", onSigterm)
  }
}

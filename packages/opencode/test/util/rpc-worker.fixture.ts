import { Rpc } from "../../src/util/rpc"

const rpc = {
  add: (input: { a: number; b: number }) => input.a + input.b,
  slow: async (input: { ms: number; value: string }) => {
    await new Promise((resolve) => setTimeout(resolve, input.ms))
    return input.value
  },
  boom: () => {
    throw new Error("boom")
  },
  rejects: async () => {
    throw new Error("async boom")
  },
  emptyWithCause: () => {
    throw new Error("", { cause: new Error("port 4096 is in use") })
  },
  announce: (input: { event: string; data: unknown }) => {
    Rpc.emit(input.event, input.data)
    return true
  },
}

Rpc.listen(rpc)
export type Definition = typeof rpc

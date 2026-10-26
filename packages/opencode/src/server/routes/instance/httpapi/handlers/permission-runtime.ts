import { Permission } from "@/permission"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"

export const permissionRuntimeHandlers = HttpApiBuilder.group(InstanceHttpApi, "permission-runtime", (handlers) =>
  Effect.gen(function* () {
    const svc = yield* Permission.Service

    const skipAll = Effect.fn("PermissionHttpApi.skipAll")(function* () {
      return yield* svc.skipAll()
    })

    const setSkipAll = Effect.fn("PermissionHttpApi.setSkipAll")(function* (ctx: {
      payload: { enabled: boolean }
      query: { workspace?: string; directory?: string }
    }) {
      // query.workspace/directory threads through WorkspaceRoutingMiddleware; declaring it here
      // makes HttpApi validate it and treat an omitted workspace as the default directory.
      void ctx.query
      yield* svc.setSkipAll(ctx.payload.enabled)
      return yield* svc.skipAll()
    })

    const careful = Effect.fn("PermissionHttpApi.careful")(function* () {
      return yield* svc.careful()
    })

    const setCareful = Effect.fn("PermissionHttpApi.setCareful")(function* (ctx: {
      payload: { enabled: boolean }
      query: { workspace?: string; directory?: string }
    }) {
      void ctx.query
      yield* svc.setCareful(ctx.payload.enabled)
      return yield* svc.careful()
    })

    return handlers
      .handle("skipAll", skipAll)
      .handle("setSkipAll", setSkipAll)
      .handle("careful", careful)
      .handle("setCareful", setCareful)
  }),
)

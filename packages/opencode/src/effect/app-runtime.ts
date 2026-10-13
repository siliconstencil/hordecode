import { Layer, ManagedRuntime } from "effect"
import { attach } from "./run-service"
import * as Observability from "@opencode-ai/core/observability"
import { Scheduler } from "@opencode-ai/cron"

import { FSUtil } from "@opencode-ai/core/fs-util"
import { Database } from "@opencode-ai/core/database/database"
import { Auth } from "@/auth"
import { Account } from "@/account/account"
import { Config } from "@/config/config"
import { Git } from "@/git"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Storage } from "@/storage/storage"
import { Snapshot } from "@/snapshot"
import { Plugin } from "@/plugin"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { Provider } from "@/provider/provider"
import { ProviderAuth } from "@/provider/auth"
import { Agent } from "@/agent/agent"
import { Skill } from "@/skill"
import { Discovery } from "@/skill/discovery"
import { Question } from "@/question"
import { Permission } from "@/permission"
import { Todo } from "@/session/todo"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { SessionRunState } from "@/session/run-state"
import { SessionProcessor } from "@/session/processor"
import { SessionCompaction } from "@/session/compaction"
import { SessionRevert } from "@/session/revert"
import { SessionSummary } from "@/session/summary"
import { SessionPrompt } from "@/session/prompt"
import { Instruction } from "@/session/instruction"
import { LLM } from "@/session/llm"
import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import { McpAuth } from "@/mcp/auth"
import { Command } from "@/command"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { Format } from "@/format"
import { InstanceStore } from "@/project/instance-store"
import { Project } from "@/project/project"
import { Vcs } from "@/project/vcs"
import { Workspace } from "@/control-plane/workspace"
import { Worktree } from "@/worktree"
import { Installation } from "@/installation"
import { ShareNext } from "@/share/share-next"
import { SessionShare } from "@/share/session"
import { Npm } from "@opencode-ai/core/npm"
import { memoMap } from "@opencode-ai/core/effect/memo-map"
import { BackgroundJob } from "@/background/job"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilderV1 } from "./app-node-builder-v1"
import { SupervisorNode, SupervisorRegistryNode, SessionCheckpointNode, SessionPruneNode, WorkflowNode, MemoryNode } from "./supervisor-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { node as EmbeddingNode } from "@opencode-ai/memory/embedding/service"
import { node as VectorStoreNode } from "@opencode-ai/memory/embedding/vector-store"
import * as BashInteractive from "@/tool/bash-interactive"
export const AppLayer = AppNodeBuilderV1.build(
  LayerNode.group([
    SupervisorRegistryNode,
    EmbeddingNode,
    VectorStoreNode,
    MemoryNode,
    Npm.node,
    FSUtil.node,
    Database.node,
    Auth.node,
    Account.node,
    Config.node,
    Git.node,
    Storage.node,
    Snapshot.node,
    Plugin.node,
    ModelsDev.node,
    Provider.node,
    ProviderAuth.node,
    Agent.node,
    Skill.node,
    Discovery.node,
    Question.node,
    Permission.node,
    Todo.node,
    Session.node,
    SessionProjector.node,
    SessionStatus.node,
    BackgroundJob.node,
    RuntimeFlags.node,
    EventV2Bridge.node,
    SessionRunState.node,
    SessionProcessor.node,
    SessionCompaction.node,
    SessionRevert.node,
    SessionSummary.node,
    SessionPrompt.node,
    Instruction.node,
    LLM.node,
    LSP.node,
    MCP.node,
    McpAuth.node,
    Command.node,
    Truncate.node,
    ToolRegistry.node,
    SupervisorNode,
    SessionCheckpointNode,
    SessionPruneNode,
    WorkflowNode,
    Format.node,
    InstanceStore.node,
    Project.node,
    Vcs.node,
    Workspace.node,
    Worktree.node,
    Installation.node,
    ShareNext.node,
    SessionShare.node,
  ]),
).pipe(
  Layer.provideMerge(AppNodeBuilderV1.build(Ripgrep.node)),
  Layer.provideMerge(Observability.layer),
  Layer.provideMerge(Scheduler.layer),
  Layer.provideMerge(BashInteractive.defaultLayer),
)

let rt: ManagedRuntime.ManagedRuntime<Layer.Success<typeof AppLayer>, Layer.Error<typeof AppLayer>> | undefined
type Runtime = Pick<ManagedRuntime.ManagedRuntime<Layer.Success<typeof AppLayer>, Layer.Error<typeof AppLayer>>, "runSync" | "runPromise" | "runPromiseExit" | "runFork" | "runCallback" | "dispose">

/** Services provided by AppRuntime — i.e.what an Effect run via AppRuntime.runPromise can yield. */
export type AppServices = Layer.Success<typeof AppLayer>
const wrap = (effect: any) => attach(effect as never) as never
const ensure = () => {
  if (!rt) rt = ManagedRuntime.make(AppLayer, { memoMap })
  return rt
}

export const AppRuntime: Runtime = {
  runSync(effect) {
    return ensure().runSync(wrap(effect))
  },
  runPromise(effect, options) {
    return ensure().runPromise(wrap(effect), options)
  },
  runPromiseExit(effect, options) {
    return ensure().runPromiseExit(wrap(effect), options)
  },
  runFork(effect) {
    return ensure().runFork(wrap(effect))
  },
  runCallback(effect) {
    return ensure().runCallback(wrap(effect))
  },
  dispose: () => {
    const p = rt?.dispose()
    rt = undefined
    return p ?? Promise.resolve()
  },
}

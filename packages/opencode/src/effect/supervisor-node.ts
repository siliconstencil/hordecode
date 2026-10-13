import { Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Supervisor } from "@opencode-ai/supervisor/spawn"
import { SupervisorRegistryService } from "@opencode-ai/supervisor/registry"
import { TaskRegistry } from "@opencode-ai/task/registry"
import { Inbox } from "@opencode-ai/inbox"
import { Bus } from "@opencode-ai/bus"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { Session } from "@/session/session"
import { Agent } from "@/agent/agent"
import { SessionPrompt } from "@/session/prompt"
import { SessionRunState } from "@/session/run-state"
import { SessionCheckpoint } from "@opencode-ai/core/session/checkpoint"
import { SessionPrune } from "@opencode-ai/core/session/prune"
import { Database } from "@opencode-ai/core/database/database"
import { Memory } from "@opencode-ai/memory"
import { node as EmbeddingNode } from "@opencode-ai/memory/embedding/service"
import { node as VectorStoreNode } from "@opencode-ai/memory/embedding/vector-store"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { Worktree } from "@/worktree"
import { WorkflowRuntime } from "@opencode-ai/workflow/runtime"

const BusNode = LayerNode.make({
  service: Bus.Service,
  layer: Bus.layer,
  deps: [],
})

export const SupervisorRegistryNode = LayerNode.make({
  service: SupervisorRegistryService.Service,
  layer: SupervisorRegistryService.defaultLayer as Layer.Layer<SupervisorRegistryService.Service, never, never>,
  deps: [],
})

export const MemoryNode = LayerNode.make({
  service: Memory.Service,
  layer: Memory.layer as Layer.Layer<Memory.Service>,
  deps: [Database.node, Config.node, EmbeddingNode, VectorStoreNode],
})

export const TaskRegistryNode = LayerNode.make({
  service: TaskRegistry.Service,
  layer: TaskRegistry.layer as Layer.Layer<TaskRegistry.Service>,
  deps: [Database.node, BusNode, Config.node],
})

const InboxNode = LayerNode.make({
  service: Inbox.Service,
  layer: Inbox.defaultLayer as Layer.Layer<Inbox.Service, never, never>,
  deps: [Database.node],
})

export const SupervisorNode = LayerNode.make({
  service: Supervisor.Service,
  layer: Supervisor.layer as Layer.Layer<Supervisor.Service, never, never>,
  deps: [
    Session.node,
    SupervisorRegistryNode,
    Agent.node,
    SessionPrompt.node,
    InboxNode,
    SessionRunState.node,
    PluginV2.node,
    BusNode,
    TaskRegistryNode,
  ],
})

export const SessionCheckpointNode = LayerNode.make({
  service: SessionCheckpoint.Service,
  layer: SessionCheckpoint.layer as Layer.Layer<SessionCheckpoint.Service, never, never>,
  deps: [
    Session.node,
    BusNode,
    Config.node,
    MemoryNode,
    TaskRegistryNode,
    SupervisorRegistryNode,
  ],
})

export const SessionPruneNode = LayerNode.make({
  service: SessionPrune.Service,
  layer: SessionPrune.layer as Layer.Layer<SessionPrune.Service, never, never>,
  deps: [Session.node, Config.node, SessionCheckpointNode, SupervisorRegistryNode],
})

// Workflow runtime: wired as an AppLayer peer with explicit deps matching the
// services its layer yields (packages/workflow/src/runtime.ts:290-299). Effect
// Context keys services by tag string, so the opencode-side nodes below satisfy
// the runtime's core-service yields ("@opencode/Provider" etc.) exactly like
// SupervisorNode satisfies Supervisor's core Session.Service. The runtime populates
// workflowRef (runtime.ts:1429), which tool/workflow.ts reads at call time.
export const WorkflowNode = LayerNode.make({
  service: WorkflowRuntime.Service,
  layer: WorkflowRuntime.layer as Layer.Layer<WorkflowRuntime.Service, never, never>,
  deps: [BusNode, InboxNode, Worktree.node, Provider.node, Config.node],
})

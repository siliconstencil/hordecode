import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionPrompt as CoreSessionPrompt } from "@opencode-ai/core/session/prompt"
import { Supervisor } from "@opencode-ai/supervisor/spawn"
import { SupervisorRegistryService } from "@opencode-ai/supervisor/registry"
import { TaskRegistry } from "@opencode-ai/task/registry"
import { Inbox } from "@opencode-ai/inbox"
import { Bus } from "@opencode-ai/bus"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { EventV2 } from "@opencode-ai/core/event"
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
import { TrustGate } from "@/project/trust-gate"

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

// Supervisor imports the core SessionPrompt service, but spawn only calls
// .prompt. The tag split would otherwise change which implementation the app
// runs; provide the mounted opencode copy under the core tag until phase 4
// decides the single loop.
export const CoreSessionPromptNode = LayerNode.make({
  service: CoreSessionPrompt.Service,
  layer: Layer.effect(
    CoreSessionPrompt.Service,
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      return prompt as unknown as CoreSessionPrompt.Interface
    }),
  ),
  deps: [SessionPrompt.node],
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
    CoreSessionPromptNode,
    InboxNode,
    SessionRunState.node,
    PluginV2.node,
    BusNode,
    TaskRegistryNode,
    // Supervisor.layer reads experimental.primary_tools through Config.Service at spawn time.
    Config.node,
  ],
})

export const SessionCheckpointNode = LayerNode.make({
  service: SessionCheckpoint.Service,
  layer: SessionCheckpoint.layer as Layer.Layer<SessionCheckpoint.Service, never, never>,
  deps: [
    Session.node,
    BusNode,
    EventV2.node,
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
// K3: the runtime cannot import the gate (packages/workflow has no opencode
// dependency), so the trust decision is injected here. K5: a child workflow file is
// a code origin, decided by the same mayRunFrom the root lookup uses.
// Upstream 1.19.5 has no workflow runtime and no gate.
export const WorkflowNode = LayerNode.make({
  service: WorkflowRuntime.Service,
  layer: WorkflowRuntime.layer({
    projectScriptGate: (file) => TrustGate.mayRunFrom(file),
  }) as Layer.Layer<WorkflowRuntime.Service, never, never>,
  deps: [BusNode, InboxNode, Worktree.node, Provider.node, Config.node, Session.node, SupervisorRegistryNode],
})

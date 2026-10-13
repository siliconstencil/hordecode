import { Effect, Layer, Types } from "effect"
import { Command } from "@/command"
import { Config } from "@/config/config"
import { TestConfig } from "../fixture/config"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { testEffect } from "../lib/effect"
import { InstanceRef } from "@/effect/instance-ref"
import { Project } from "@opencode-ai/schema/project"
import { MCP } from "@/mcp"
import { Skill } from "@/skill"

export function makeCommandLayerTest(
  worktreeDir = "/tmp/test-command",
  overrides?: {
    mcp?: Layer.Layer<MCP.Service>
    skill?: Layer.Layer<Skill.Service>
  },
) {
  const mockInstance = Layer.succeed(InstanceRef, {
    directory: worktreeDir,
    worktree: worktreeDir,
    project: Project.Info.make({
      id: Project.ID.make("test"),
      worktree: worktreeDir,
      time: { created: 0, updated: 0 },
      sandboxes: [],
    }) as Types.DeepMutable<typeof Project.Info.Type>,
  })

  const items: Array<[any, any]> = [[Config.node, TestConfig.layer()]]
  if (overrides?.mcp) items.push([MCP.node, overrides.mcp])
  if (overrides?.skill) items.push([Skill.node, overrides.skill])

  const layer = LayerNode.compile(Command.node, items).pipe(
    Layer.provideMerge(mockInstance),
  )

  return testEffect(layer)
}

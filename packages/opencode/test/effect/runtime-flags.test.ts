import { describe, expect } from "bun:test"
import { ConfigProvider, Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { it } from "../lib/effect"

const fromConfig = (input: Record<string, unknown>) =>
  AppNodeBuilder.build(RuntimeFlags.node).pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(input))))

const readFlags = RuntimeFlags.Service.useSync((flags) => flags)

describe("RuntimeFlags", () => {
  it.effect("layer defaults autoShare to false", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(Effect.provide(fromConfig({})))

      expect(flags.autoShare).toBe(false)
    }),
  )

  it.effect("layer parses plugin flags from the active ConfigProvider", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(
        Effect.provide(
          fromConfig({
            OPENCODE_PURE: "true",
            OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
            OPENCODE_AUTO_SHARE: "true",
            OPENCODE_DISABLE_EMBEDDED_WEB_UI: "true",
            OPENCODE_DISABLE_EXTERNAL_SKILLS: "true",
            OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
            OPENCODE_EXPERIMENTAL: "true",
            OPENCODE_ENABLE_EXA: "true",
            OPENCODE_ENABLE_PARALLEL: "true",
            OPENCODE_ENABLE_EXPERIMENTAL_MODELS: "true",
            OPENCODE_ENABLE_QUESTION_TOOL: "true",
            OPENCODE_CLIENT: "desktop",
          }),
        ),
      )

      expect(flags.pure).toBe(true)
      expect(flags.autoShare).toBe(true)
      expect(flags.disableDefaultPlugins).toBe(true)
      expect(flags.disableEmbeddedWebUi).toBe(true)
      expect(flags.disableExternalSkills).toBe(true)
      expect(flags.disableLspDownload).toBe(true)
      expect(flags.disableClaudeCodePrompt).toBe(false)
      expect(flags.enableExa).toBe(true)
      expect(flags.enableParallel).toBe(true)
      expect(flags.enableExperimentalModels).toBe(true)
      expect(flags.enableQuestionTool).toBe(true)
      expect(flags.experimentalReferences).toBe(true)
      expect(flags.experimentalBackgroundSubagents).toBe(true)
      expect(flags.experimentalLspTy).toBe(false)
      expect(flags.experimentalLspTool).toBe(true)
      expect(flags.experimentalOxfmt).toBe(true)
      expect(flags.experimentalPlanMode).toBe(true)
      expect(flags.experimentalEventSystem).toBe(true)
      expect(flags.experimentalWorkspaces).toBe(true)
      expect(flags.experimentalIconDiscovery).toBe(true)
      expect(flags.experimentalNativeLlm).toBe(false)
      expect(flags.experimentalWebSockets).toBe(false)
      expect(flags.client).toBe("desktop")
    }),
  )

  it.effect("layer parses OPENCODE_EXPERIMENTAL_LSP_TY", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(
        Effect.provide(
          fromConfig({
            OPENCODE_EXPERIMENTAL_LSP_TY: "true",
          }),
        ),
      )

      expect(flags.experimentalLspTy).toBe(true)
    }),
  )

  it.effect("enables native LLM via dedicated flag only", () =>
    Effect.gen(function* () {
      const explicit = yield* readFlags.pipe(Effect.provide(fromConfig({ OPENCODE_EXPERIMENTAL_NATIVE_LLM: "true" })))
      const umbrella = yield* readFlags.pipe(Effect.provide(fromConfig({ OPENCODE_EXPERIMENTAL: "true" })))

      expect(explicit.experimentalNativeLlm).toBe(true)
      expect(umbrella.experimentalNativeLlm).toBe(false)
    }),
  )

  it.effect("enables WebSockets via dedicated flag only", () =>
    Effect.gen(function* () {
      const explicit = yield* readFlags.pipe(Effect.provide(fromConfig({ OPENCODE_EXPERIMENTAL_WEBSOCKETS: "true" })))
      const umbrella = yield* readFlags.pipe(Effect.provide(fromConfig({ OPENCODE_EXPERIMENTAL: "true" })))

      expect(explicit.experimentalWebSockets).toBe(true)
      expect(umbrella.experimentalWebSockets).toBe(false)
    }),
  )

  it.effect("layer accepts partial test overrides and fills defaults from Config definitions", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(
        Effect.provide(RuntimeFlags.layer({ disableDefaultPlugins: true, bashDefaultTimeoutMs: 1_000 })),
      )

      expect(flags.pure).toBe(false)
      expect(flags.autoShare).toBe(false)
      expect(flags.disableDefaultPlugins).toBe(true)
      expect(flags.disableEmbeddedWebUi).toBe(false)
      expect(flags.disableExternalSkills).toBe(false)
      expect(flags.disableLspDownload).toBe(false)
      expect(flags.disableClaudeCodePrompt).toBe(false)
      expect(flags.disableClaudeCodeSkills).toBe(false)
      expect(flags.enableExa).toBe(false)
      expect(flags.experimentalIconDiscovery).toBe(false)
      expect(flags.experimentalOxfmt).toBe(false)
      expect(flags.outputTokenMax).toBeUndefined()
      expect(flags.bashDefaultTimeoutMs).toBe(1_000)
      expect(flags.enableExperimentalModels).toBe(false)
      expect(flags.client).toBe("cli")
    }),
  )

  it.effect("experimentalIconDiscovery defaults to false", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(Effect.provide(fromConfig({})))

      expect(flags.experimentalIconDiscovery).toBe(false)
    }),
  )

  it.effect("disableExternalSkills defaults to false", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(Effect.provide(fromConfig({})))

      expect(flags.disableExternalSkills).toBe(false)
    }),
  )

  it.effect("disableExternalSkills reads OPENCODE_DISABLE_EXTERNAL_SKILLS", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(Effect.provide(fromConfig({ OPENCODE_DISABLE_EXTERNAL_SKILLS: "true" })))

      expect(flags.disableExternalSkills).toBe(true)
    }),
  )

  it.effect("disableLspDownload defaults to false", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(Effect.provide(fromConfig({})))

      expect(flags.disableLspDownload).toBe(false)
    }),
  )

  it.effect("disableLspDownload reads OPENCODE_DISABLE_LSP_DOWNLOAD", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(Effect.provide(fromConfig({ OPENCODE_DISABLE_LSP_DOWNLOAD: "true" })))

      expect(flags.disableLspDownload).toBe(true)
    }),
  )

  it.effect("disableClaudeCodePrompt defaults to false", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(Effect.provide(fromConfig({})))

      expect(flags.disableClaudeCodePrompt).toBe(false)
    }),
  )

  it.effect("disableClaudeCodePrompt reads OPENCODE_DISABLE_CLAUDE_CODE_PROMPT", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(Effect.provide(fromConfig({ OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: "true" })))

      expect(flags.disableClaudeCodePrompt).toBe(true)
    }),
  )

  it.effect("disableClaudeCodePrompt inherits OPENCODE_DISABLE_CLAUDE_CODE", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(Effect.provide(fromConfig({ OPENCODE_DISABLE_CLAUDE_CODE: "true" })))

      expect(flags.disableClaudeCodePrompt).toBe(true)
    }),
  )

  it.effect("experimentalIconDiscovery reads OPENCODE_EXPERIMENTAL_ICON_DISCOVERY", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(Effect.provide(fromConfig({ OPENCODE_EXPERIMENTAL_ICON_DISCOVERY: "true" })))

      expect(flags.experimentalIconDiscovery).toBe(true)
    }),
  )

  it.effect("experimentalIconDiscovery inherits OPENCODE_EXPERIMENTAL", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(Effect.provide(fromConfig({ OPENCODE_EXPERIMENTAL: "true" })))

      expect(flags.experimentalIconDiscovery).toBe(true)
    }),
  )

  it.effect("specific experimental flags override OPENCODE_EXPERIMENTAL", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(
        Effect.provide(
          fromConfig({
            OPENCODE_EXPERIMENTAL: "true",
            OPENCODE_EXPERIMENTAL_ICON_DISCOVERY: "false",
          }),
        ),
      )

      expect(flags.experimentalIconDiscovery).toBe(false)
    }),
  )

  it.effect("experimentalOxfmt defaults to false", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(Effect.provide(fromConfig({})))

      expect(flags.experimentalOxfmt).toBe(false)
    }),
  )

  it.effect("experimentalOxfmt is enabled by OPENCODE_EXPERIMENTAL_OXFMT", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(
        Effect.provide(
          fromConfig({
            OPENCODE_EXPERIMENTAL_OXFMT: "true",
          }),
        ),
      )

      expect(flags.experimentalOxfmt).toBe(true)
    }),
  )

  it.effect("experimentalOxfmt inherits OPENCODE_EXPERIMENTAL", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(
        Effect.provide(
          fromConfig({
            OPENCODE_EXPERIMENTAL: "true",
          }),
        ),
      )

      expect(flags.experimentalOxfmt).toBe(true)
    }),
  )

  for (const input of [
    { name: "absent", config: {}, expected: undefined },
    {
      name: "valid positive integer",
      config: { OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS: "1234" },
      expected: 1234,
    },
    {
      name: "invalid string",
      config: { OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS: "nope" },
      expected: undefined,
    },
    { name: "zero", config: { OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS: "0" }, expected: undefined },
    { name: "negative", config: { OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS: "-1" }, expected: undefined },
    {
      name: "non-integer",
      config: { OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS: "1.5" },
      expected: undefined,
    },
  ]) {
    it.effect(`parses bashDefaultTimeoutMs from config: ${input.name}`, () =>
      Effect.gen(function* () {
        const flags = yield* readFlags.pipe(Effect.provide(fromConfig(input.config)))

        expect(flags.bashDefaultTimeoutMs).toBe(input.expected)
      }),
    )
  }

  for (const input of [
    { name: "absent", config: {}, expected: undefined },
    {
      name: "valid positive integer",
      config: { OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX: "1234" },
      expected: 1234,
    },
    {
      name: "invalid string",
      config: { OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX: "nope" },
      expected: undefined,
    },
    { name: "zero", config: { OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX: "0" }, expected: undefined },
    { name: "negative", config: { OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX: "-1" }, expected: undefined },
    {
      name: "non-integer",
      config: { OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX: "1.5" },
      expected: undefined,
    },
  ]) {
    it.effect(`parses outputTokenMax from config: ${input.name}`, () =>
      Effect.gen(function* () {
        const flags = yield* readFlags.pipe(Effect.provide(fromConfig(input.config)))

        expect(flags.outputTokenMax).toBe(input.expected)
      }),
    )
  }

  it.effect("layer ignores the active ConfigProvider for omitted test overrides", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(
        Effect.provide(RuntimeFlags.layer()),
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              OPENCODE_PURE: "true",
              OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
              OPENCODE_DISABLE_EXTERNAL_SKILLS: "true",
              OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
              OPENCODE_EXPERIMENTAL: "true",
              OPENCODE_ENABLE_EXA: "true",
              OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS: "1234",
              OPENCODE_CLIENT: "desktop",
            }),
          ),
        ),
      )

      expect(flags.pure).toBe(false)
      expect(flags.disableDefaultPlugins).toBe(false)
      expect(flags.disableEmbeddedWebUi).toBe(false)
      expect(flags.disableExternalSkills).toBe(false)
      expect(flags.disableLspDownload).toBe(false)
      expect(flags.disableClaudeCodePrompt).toBe(false)
      expect(flags.disableClaudeCodeSkills).toBe(false)
      expect(flags.enableExa).toBe(false)
      expect(flags.experimentalIconDiscovery).toBe(false)
      expect(flags.experimentalOxfmt).toBe(false)
      expect(flags.outputTokenMax).toBeUndefined()
      expect(flags.bashDefaultTimeoutMs).toBeUndefined()
      expect(flags.client).toBe("cli")
    }),
  )

  it.effect("disableClaudeCodeSkills defaults to false", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(Effect.provide(fromConfig({})))

      expect(flags.disableClaudeCodeSkills).toBe(false)
    }),
  )

  it.effect("disableClaudeCodeSkills reads OPENCODE_DISABLE_CLAUDE_CODE_SKILLS", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(Effect.provide(fromConfig({ OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "true" })))

      expect(flags.disableClaudeCodeSkills).toBe(true)
    }),
  )

  it.effect("disableClaudeCodeSkills inherits OPENCODE_DISABLE_CLAUDE_CODE", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(Effect.provide(fromConfig({ OPENCODE_DISABLE_CLAUDE_CODE: "true" })))

      expect(flags.disableClaudeCodeSkills).toBe(true)
    }),
  )

  it.effect("pure reads HORDECODE_PURE", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(Effect.provide(fromConfig({ HORDECODE_PURE: "1" })))

      expect(flags.pure).toBe(true)
    }),
  )

  it.effect("pure still reads OPENCODE_PURE (upstream compatibility)", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(Effect.provide(fromConfig({ OPENCODE_PURE: "1" })))

      expect(flags.pure).toBe(true)
    }),
  )

  it.effect("pure defaults to false when neither HORDECODE_PURE nor OPENCODE_PURE is set", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(Effect.provide(fromConfig({})))

      expect(flags.pure).toBe(false)
    }),
  )

  it.effect("client reads HORDECODE_CLIENT", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(Effect.provide(fromConfig({ HORDECODE_CLIENT: "myvalue" })))

      expect(flags.client).toBe("myvalue")
    }),
  )

  it.effect("client still reads OPENCODE_CLIENT (upstream compatibility)", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(Effect.provide(fromConfig({ OPENCODE_CLIENT: "myvalue" })))

      expect(flags.client).toBe("myvalue")
    }),
  )

  // HORDECODE_* twin wiring for the remaining 13 fields

  it.effect("experimental umbrella enables experimentalIconDiscovery via HORDECODE_EXPERIMENTAL", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(Effect.provide(fromConfig({ HORDECODE_EXPERIMENTAL: "1" })))

      expect(flags.experimentalIconDiscovery).toBe(true)
    }),
  )

  it.effect("experimental umbrella still enables experimentalIconDiscovery via OPENCODE_EXPERIMENTAL (upstream compatibility)", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(Effect.provide(fromConfig({ OPENCODE_EXPERIMENTAL: "1" })))

      expect(flags.experimentalIconDiscovery).toBe(true)
    }),
  )

  it.effect("autoShare reads HORDECODE_AUTO_SHARE", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(Effect.provide(fromConfig({ HORDECODE_AUTO_SHARE: "1" })))

      expect(flags.autoShare).toBe(true)
    }),
  )

  it.effect("autoShare still reads OPENCODE_AUTO_SHARE (upstream compatibility)", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(Effect.provide(fromConfig({ OPENCODE_AUTO_SHARE: "1" })))

      expect(flags.autoShare).toBe(true)
    }),
  )

  it.effect("disableDefaultPlugins reads HORDECODE_DISABLE_DEFAULT_PLUGINS", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(Effect.provide(fromConfig({ HORDECODE_DISABLE_DEFAULT_PLUGINS: "1" })))

      expect(flags.disableDefaultPlugins).toBe(true)
    }),
  )

  it.effect("disableDefaultPlugins still reads OPENCODE_DISABLE_DEFAULT_PLUGINS (upstream compatibility)", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(Effect.provide(fromConfig({ OPENCODE_DISABLE_DEFAULT_PLUGINS: "1" })))

      expect(flags.disableDefaultPlugins).toBe(true)
    }),
  )

  it.effect("disableEmbeddedWebUi reads HORDECODE_DISABLE_EMBEDDED_WEB_UI", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(Effect.provide(fromConfig({ HORDECODE_DISABLE_EMBEDDED_WEB_UI: "1" })))

      expect(flags.disableEmbeddedWebUi).toBe(true)
    }),
  )

  it.effect("disableEmbeddedWebUi still reads OPENCODE_DISABLE_EMBEDDED_WEB_UI (upstream compatibility)", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(Effect.provide(fromConfig({ OPENCODE_DISABLE_EMBEDDED_WEB_UI: "1" })))

      expect(flags.disableEmbeddedWebUi).toBe(true)
    }),
  )

  it.effect("disableExternalSkills reads HORDECODE_DISABLE_EXTERNAL_SKILLS", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(Effect.provide(fromConfig({ HORDECODE_DISABLE_EXTERNAL_SKILLS: "1" })))

      expect(flags.disableExternalSkills).toBe(true)
    }),
  )

  it.effect("disableExternalSkills still reads OPENCODE_DISABLE_EXTERNAL_SKILLS (upstream compatibility)", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(Effect.provide(fromConfig({ OPENCODE_DISABLE_EXTERNAL_SKILLS: "1" })))

      expect(flags.disableExternalSkills).toBe(true)
    }),
  )

  it.effect("disableLspDownload reads HORDECODE_DISABLE_LSP_DOWNLOAD", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(Effect.provide(fromConfig({ HORDECODE_DISABLE_LSP_DOWNLOAD: "1" })))

      expect(flags.disableLspDownload).toBe(true)
    }),
  )

  it.effect("disableLspDownload still reads OPENCODE_DISABLE_LSP_DOWNLOAD (upstream compatibility)", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(Effect.provide(fromConfig({ OPENCODE_DISABLE_LSP_DOWNLOAD: "1" })))

      expect(flags.disableLspDownload).toBe(true)
    }),
  )

  it.effect("disableClaudeCodePrompt reads HORDECODE_DISABLE_CLAUDE_CODE_PROMPT", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(Effect.provide(fromConfig({ HORDECODE_DISABLE_CLAUDE_CODE_PROMPT: "1" })))

      expect(flags.disableClaudeCodePrompt).toBe(true)
    }),
  )

  it.effect("disableClaudeCodePrompt still reads OPENCODE_DISABLE_CLAUDE_CODE_PROMPT (upstream compatibility)", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(Effect.provide(fromConfig({ OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: "1" })))

      expect(flags.disableClaudeCodePrompt).toBe(true)
    }),
  )

  it.effect("disableClaudeCodePrompt inherits HORDECODE_DISABLE_CLAUDE_CODE", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(Effect.provide(fromConfig({ HORDECODE_DISABLE_CLAUDE_CODE: "1" })))

      expect(flags.disableClaudeCodePrompt).toBe(true)
    }),
  )

  it.effect("disableClaudeCodeSkills reads HORDECODE_DISABLE_CLAUDE_CODE_SKILLS", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(Effect.provide(fromConfig({ HORDECODE_DISABLE_CLAUDE_CODE_SKILLS: "1" })))

      expect(flags.disableClaudeCodeSkills).toBe(true)
    }),
  )

  it.effect("disableClaudeCodeSkills still reads OPENCODE_DISABLE_CLAUDE_CODE_SKILLS (upstream compatibility)", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(Effect.provide(fromConfig({ OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1" })))

      expect(flags.disableClaudeCodeSkills).toBe(true)
    }),
  )

  it.effect("disableClaudeCodeSkills inherits HORDECODE_DISABLE_CLAUDE_CODE", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(Effect.provide(fromConfig({ HORDECODE_DISABLE_CLAUDE_CODE: "1" })))

      expect(flags.disableClaudeCodeSkills).toBe(true)
    }),
  )

  it.effect("enableExa reads HORDECODE_ENABLE_EXA", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(Effect.provide(fromConfig({ HORDECODE_ENABLE_EXA: "1" })))

      expect(flags.enableExa).toBe(true)
    }),
  )

  it.effect("enableExa still reads OPENCODE_ENABLE_EXA (upstream compatibility)", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(Effect.provide(fromConfig({ OPENCODE_ENABLE_EXA: "1" })))

      expect(flags.enableExa).toBe(true)
    }),
  )

  it.effect("enableExa legacy reads HORDECODE_EXPERIMENTAL_EXA", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(Effect.provide(fromConfig({ HORDECODE_EXPERIMENTAL_EXA: "1" })))

      expect(flags.enableExa).toBe(true)
    }),
  )

  it.effect("enableExa legacy still reads OPENCODE_EXPERIMENTAL_EXA (upstream compatibility)", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(Effect.provide(fromConfig({ OPENCODE_EXPERIMENTAL_EXA: "1" })))

      expect(flags.enableExa).toBe(true)
    }),
  )

  it.effect("enableExperimentalModels reads HORDECODE_ENABLE_EXPERIMENTAL_MODELS", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(Effect.provide(fromConfig({ HORDECODE_ENABLE_EXPERIMENTAL_MODELS: "1" })))

      expect(flags.enableExperimentalModels).toBe(true)
    }),
  )

  it.effect("enableExperimentalModels still reads OPENCODE_ENABLE_EXPERIMENTAL_MODELS (upstream compatibility)", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(Effect.provide(fromConfig({ OPENCODE_ENABLE_EXPERIMENTAL_MODELS: "1" })))

      expect(flags.enableExperimentalModels).toBe(true)
    }),
  )

  it.effect("enableQuestionTool reads HORDECODE_ENABLE_QUESTION_TOOL", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(Effect.provide(fromConfig({ HORDECODE_ENABLE_QUESTION_TOOL: "1" })))

      expect(flags.enableQuestionTool).toBe(true)
    }),
  )

  it.effect("enableQuestionTool still reads OPENCODE_ENABLE_QUESTION_TOOL (upstream compatibility)", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(Effect.provide(fromConfig({ OPENCODE_ENABLE_QUESTION_TOOL: "1" })))

      expect(flags.enableQuestionTool).toBe(true)
    }),
  )

  it.effect("experimentalLspTy reads HORDECODE_EXPERIMENTAL_LSP_TY", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(Effect.provide(fromConfig({ HORDECODE_EXPERIMENTAL_LSP_TY: "1" })))

      expect(flags.experimentalLspTy).toBe(true)
    }),
  )

  it.effect("experimentalLspTy still reads OPENCODE_EXPERIMENTAL_LSP_TY (upstream compatibility)", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(Effect.provide(fromConfig({ OPENCODE_EXPERIMENTAL_LSP_TY: "1" })))

      expect(flags.experimentalLspTy).toBe(true)
    }),
  )
})

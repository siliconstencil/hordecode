import path from "path"
import { Effect, Schema } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { SessionCwd } from "@opencode-ai/core/tool/session-cwd"
import { isImageAttachment, sniffAttachmentMime } from "@opencode-ai/core/util/media"
import { assertExternalDirectoryEffect } from "./external-directory"
import * as Tool from "./tool"
import DESCRIPTION from "./view-image.txt"

const Parameters = Schema.Struct({
  path: Schema.String.annotate({ description: "Local filesystem path to an image file." }),
  detail: Schema.optional(Schema.Literals(["high", "original"])).annotate({
    description: "Image detail level. Defaults to `high`; use `original` to preserve exact resolution.",
  }),
})

const SUPPORTED_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"])

export const ViewImageTool = Tool.define(
  "view_image",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const model = (ctx.extra as { model?: { capabilities?: { input?: { image?: boolean } } } } | undefined)?.model
          if (!model?.capabilities?.input?.image) {
            return yield* Effect.fail(new Error("view_image is not allowed because you do not support image inputs"))
          }

          const instance = yield* InstanceState.context
          const cwd = SessionCwd.get(ctx.sessionID, instance.directory)
          const filepath =
            process.platform === "win32"
              ? FSUtil.normalizePath(path.isAbsolute(params.path) ? params.path : path.resolve(cwd, params.path))
              : path.isAbsolute(params.path)
                ? params.path
                : path.resolve(cwd, params.path)

          const stat = yield* fs.stat(filepath).pipe(Effect.catch(() => Effect.succeed(undefined)))

          yield* assertExternalDirectoryEffect(ctx, filepath, { kind: "file" })
          yield* ctx.ask({
            permission: "read",
            patterns: [filepath],
            always: ["*"],
            metadata: {},
          })

          if (!stat) {
            return yield* Effect.fail(new Error(`unable to locate image at \`${filepath}\``))
          }
          if (stat.type !== "File") {
            return yield* Effect.fail(new Error(`image path \`${filepath}\` is not a file`))
          }

          const bytes = yield* fs.readFile(filepath)
          const mime = sniffAttachmentMime(bytes.subarray(0, 4096), FSUtil.mimeType(filepath))
          if (!isImageAttachment(mime) || !SUPPORTED_MIMES.has(mime)) {
            return yield* Effect.fail(
              new Error(`image path \`${filepath}\` is not a supported JPEG, PNG, GIF, or WebP image`),
            )
          }

          const detail = params.detail ?? "high"
          return {
            title: path.relative(instance.worktree, filepath) || path.basename(filepath),
            output: `Image viewed successfully (${detail} detail)`,
            metadata: { detail },
            attachments: [
              {
                type: "file" as const,
                mime,
                url: `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`,
                filename: path.basename(filepath),
              },
            ],
          }
        }).pipe(Effect.orDie),
    }
  }),
)

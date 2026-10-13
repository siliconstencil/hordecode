import path from "path"
import { Effect, Schema } from "effect"
import { createTwoFilesPatch } from "diff"
import * as Tool from "./tool"
import DESCRIPTION from "./notebook-edit.txt"
import { InstanceState } from "@/effect/instance-state"
import { SessionCwd } from "@opencode-ai/core/tool/session-cwd"
import { assertFileRead } from "./read-state"
import { assertWriteAllowed, askEditUnlessMemory } from "./external-directory"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Format } from "../format"
import { FSUtil } from "@opencode-ai/core/fs-util"

const Parameters = Schema.Struct({
  notebook_path: Schema.String,
  cell_id: Schema.optional(Schema.String),
  new_source: Schema.optional(Schema.String),
  cell_type: Schema.optional(Schema.Literals(["code", "markdown"])),
  edit_mode: Schema.optional(Schema.Literals(["replace", "insert", "delete"])),
})

type Metadata = Record<string, never>

type NotebookCell = {
  cell_type: string
  id?: string
  source: string | string[]
  metadata?: Record<string, unknown>
  outputs?: unknown[]
  execution_count?: number | null
}

type Notebook = {
  cells: NotebookCell[]
  metadata?: Record<string, unknown>
  nbformat?: number
  nbformat_minor?: number
}

function stringToCellSource(content: string): string[] {
  if (content === "") return []
  const lines = content.split("\n")
  return lines.map((line, i) => (i < lines.length - 1 ? line + "\n" : line)).filter((line) => line !== "")
}

function generateCellId(existing: Set<string>): string {
  for (let i = 0; i < 1000; i++) {
    const id = crypto.randomUUID().slice(0, 8)
    if (!existing.has(id)) return id
  }
  return crypto.randomUUID()
}

function buildCell(cellType: "code" | "markdown", source: string, id: string): NotebookCell {
  const sourceLines = stringToCellSource(source)
  if (cellType === "code") {
    return { cell_type: "code", id, source: sourceLines, metadata: {}, outputs: [], execution_count: null }
  }
  return { cell_type: "markdown", id, source: sourceLines, metadata: {} }
}

function trimDiff(diff: string): string {
  const lines = diff.split("\n")
  const contentLines = lines.filter(
    (line) =>
      (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) &&
      !line.startsWith("---") &&
      !line.startsWith("+++"),
  )
  if (contentLines.length === 0) return diff
  let min = Infinity
  for (const line of contentLines) {
    const content = line.slice(1)
    if (content.trim().length > 0) {
      const match = content.match(/^(\s*)/)
      if (match) min = Math.min(min, match[1].length)
    }
  }
  if (min === Infinity || min === 0) return diff
  const trimmedLines = lines.map((line) => {
    if (
      (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) &&
      !line.startsWith("---") &&
      !line.startsWith("+++")
    ) {
      return line.slice(0, 1) + line.slice(min + 1)
    }
    return line
  })
  return trimmedLines.join("\n")
}

export const NotebookEditTool = Tool.define<typeof Parameters, Metadata, FSUtil.Service | Format.Service | EventV2Bridge.Service>(
  "notebook_edit",
  Effect.gen(function* () {
    const afs = yield* FSUtil.Service
    const format = yield* Format.Service
    const events = yield* EventV2Bridge.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (input: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instanceCtx = yield* InstanceState.context
          const editMode = input.edit_mode ?? "replace"

          if (!input.notebook_path) return { title: "error", output: "notebook_path is required", metadata: {} as Metadata }
          if (path.extname(input.notebook_path) !== ".ipynb") {
            return { title: "error", output: "notebook_path must point to a .ipynb file", metadata: {} as Metadata }
          }

          const notebookPath = path.isAbsolute(input.notebook_path)
            ? input.notebook_path
            : // Session cwd (change_directory) anchors relative paths; MiMo Code 0.1.11 tool/notebook-edit.ts:106.
              path.resolve(SessionCwd.get(ctx.sessionID, instanceCtx.directory), input.notebook_path)

          yield* assertWriteAllowed(ctx, notebookPath)
          assertFileRead(ctx, notebookPath, "notebook_edit", instanceCtx.directory)

          if (editMode !== "insert") {
            if (!input.cell_id) return { title: "error", output: `cell_id is required when edit_mode is "${editMode}"`, metadata: {} as Metadata }
          }
          if ((editMode === "replace" || editMode === "insert") && input.new_source === undefined) {
            return { title: "error", output: `new_source is required when edit_mode is "${editMode}"`, metadata: {} as Metadata }
          }
          if (editMode === "insert" && !input.cell_type) {
            return { title: "error", output: 'cell_type is required when edit_mode is "insert"', metadata: {} as Metadata }
          }

          const contentOld = yield* Effect.tryPromise({
            try: () => Bun.file(notebookPath).text(),
            catch: () => new Error(`File not found: ${notebookPath}`),
          })

          let notebook: Notebook
          try {
            notebook = JSON.parse(contentOld) as Notebook
          } catch (err) {
            return { title: "error", output: `Failed to parse notebook JSON: ${(err as Error).message}`, metadata: {} as Metadata }
          }

          if (!Array.isArray(notebook.cells)) {
            return { title: "error", output: "Notebook is missing a `cells` array", metadata: {} as Metadata }
          }

          const existingIds = new Set<string>()
          for (const cell of notebook.cells) if (cell.id) existingIds.add(cell.id)
          let backfilled = false
          for (const cell of notebook.cells) {
            if (cell.id) continue
            const id = generateCellId(existingIds)
            cell.id = id
            existingIds.add(id)
            backfilled = true
          }
          if (backfilled && (notebook.nbformat_minor ?? 0) < 5) {
            notebook.nbformat_minor = 5
          }

          const findIndex = (ref: string) => {
            if (ref.startsWith("#")) {
              const idx = Number.parseInt(ref.slice(1), 10)
              if (Number.isInteger(idx) && idx >= 0 && idx < notebook.cells.length) return idx
              return -1
            }
            return notebook.cells.findIndex((c) => c.id === ref)
          }

          let title = ""

          if (editMode === "replace") {
            const cellId = input.cell_id!
            const idx = findIndex(cellId)
            if (idx === -1) {
              const ids = notebook.cells.map((c, i) => c.id ?? `#${i}`).join(", ")
              return { title: "error", output: `Cell not found: ${cellId}. Available cells: ${ids || "(none)"}`, metadata: {} as Metadata }
            }
            const targetCell = notebook.cells[idx]
            const nextType: "code" | "markdown" =
              input.cell_type !== undefined ? input.cell_type : (targetCell.cell_type === "raw" ? "code" : (targetCell.cell_type as "code" | "markdown"))
            const replaced = buildCell(nextType, input.new_source ?? "", targetCell.id ?? cellId)
            if (targetCell.cell_type === "code" && nextType === "code") {
              replaced.outputs = targetCell.outputs ?? []
              replaced.execution_count = targetCell.execution_count ?? null
              replaced.metadata = targetCell.metadata ?? {}
            } else {
              replaced.metadata = targetCell.metadata ?? {}
            }
            notebook.cells[idx] = replaced
            title = `replace cell ${targetCell.id ?? `#${idx}`}`
          } else if (editMode === "delete") {
            const cellId = input.cell_id!
            const idx = findIndex(cellId)
            if (idx === -1) {
              const ids = notebook.cells.map((c, i) => c.id ?? `#${i}`).join(", ")
              return { title: "error", output: `Cell not found: ${cellId}. Available cells: ${ids || "(none)"}`, metadata: {} as Metadata }
            }
            notebook.cells.splice(idx, 1)
            title = `delete cell ${cellId}`
          } else {
            const newId = generateCellId(existingIds)
            const cell = buildCell(input.cell_type!, input.new_source ?? "", newId)
            if (!input.cell_id) {
              notebook.cells.unshift(cell)
              title = "insert cell at start"
            } else {
              const idx = findIndex(input.cell_id)
              if (idx === -1) {
                const ids = notebook.cells.map((c, i) => c.id ?? `#${i}`).join(", ")
                return { title: "error", output: `Cell not found: ${input.cell_id}. Available cells: ${ids || "(none)"}`, metadata: {} as Metadata }
              }
              notebook.cells.splice(idx + 1, 0, cell)
              title = `insert cell after ${input.cell_id}`
            }
          }

          const contentNew = JSON.stringify(notebook, null, 1) + (contentOld.endsWith("\n") ? "\n" : "")
          const diff = trimDiff(createTwoFilesPatch(notebookPath, notebookPath, contentOld, contentNew))
          const relPath = path.relative(instanceCtx.directory, notebookPath)

          yield* askEditUnlessMemory(ctx, notebookPath, {
            patterns: [path.relative(instanceCtx.worktree, notebookPath)],
            diff,
          })

          yield* afs.writeWithDirs(notebookPath, contentNew).pipe(
            Effect.catch(() => Effect.fail(new Error(`Failed to write: ${notebookPath}`))),
          )
          yield* format.file(notebookPath)
          yield* events.publish(FileSystem.Event.Edited, { file: notebookPath })
          yield* events.publish(Watcher.Event.Updated, {
            file: notebookPath,
            event: "change",
          })

          return {
            title: `${relPath} — ${title}`,
            output: `Notebook updated: ${editMode} on ${relPath}.\n\n${diff}`,
            metadata: {} as Metadata,
          }
        }).pipe(Effect.orDie),
    }
  }),
)

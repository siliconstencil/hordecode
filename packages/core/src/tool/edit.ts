/**
 * Model-facing V2 exact-edit leaf. Relative paths resolve within the active
 * Location. Absolute paths inside that Location are accepted, while explicit
 * absolute external paths retain mutation capability through a separate
 * external_directory approval before edit approval.
 */
export * as EditTool from "./edit"

import { ToolFailure } from "@opencode-ai/llm"
import { FileDiff } from "@opencode-ai/schema/file-diff"
import { createTwoFilesPatch, diffLines } from "diff"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { FileMutation } from "../file-mutation"
import { FSUtil } from "../fs-util"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { ToolRegistry } from "./registry"
import { assertFileRead } from "./read-state"
import { Tool } from "./tool"
import { Tools } from "./tools"

// TODO: Add formatter integration after V2 formatter runtime exists.
// TODO: Publish watcher/file-edit events after V2 watcher integration exists.
// TODO: Add snapshots / undo after design exists.
// TODO: Add LSP notification and diagnostics after V2 LSP runtime exists.

export const name = "edit"

export const Input = Schema.Struct({
  path: Schema.String.annotate({
    description:
      "File path to edit. Relative paths resolve within the active Location. Absolute paths inside that Location are accepted; external absolute paths require external_directory approval.",
  }),
  oldString: Schema.String.annotate({ description: "Exact text to replace" }),
  newString: Schema.String.annotate({ description: "Replacement text, which must differ from oldString" }),
  replaceAll: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Replace all exact occurrences of oldString (default false)",
  }),
})

export const Output = Schema.Struct({
  files: Schema.Array(FileDiff.Info),
  replacements: Schema.Number,
})
export type Output = typeof Output.Type

const normalizeLineEndings = (text: string) => text.replaceAll("\r\n", "\n")
const detectLineEnding = (text: string): "\n" | "\r\n" => (text.includes("\r\n") ? "\r\n" : "\n")
const convertToLineEnding = (text: string, ending: "\n" | "\r\n") =>
  ending === "\n" ? normalizeLineEndings(text) : normalizeLineEndings(text).replaceAll("\n", "\r\n")

const splitBom = (text: string) =>
  text.startsWith("\uFEFF") ? { bom: true, text: text.slice(1) } : { bom: false, text }
const joinBom = (text: string, bom: boolean) => (bom ? `\uFEFF${text}` : text)
const decodeUtf8 = (content: Uint8Array) => {
  const bom = content[0] === 0xef && content[1] === 0xbb && content[2] === 0xbf
  return { bom, content, text: new TextDecoder().decode(bom ? content.slice(3) : content) }
}

const countOccurrences = (content: string, search: string) => {
  if (search === "") return content.length + 1
  let count = 0
  let offset = 0
  while ((offset = content.indexOf(search, offset)) !== -1) {
    count++
    offset += search.length
  }
  return count
}

const previewLines = (value: string, prefix: "+" | "-") => {
  const lines = normalizeLineEndings(value).split("\n")
  const shown = lines.slice(0, 6).map((line) => `${prefix}${line.length > 240 ? `${line.slice(0, 240)}...` : line}`)
  if (lines.length > shown.length) shown.push(`${prefix}...`)
  return shown
}

export const toModelOutput = (output: Output, oldString: string, newString: string) =>
  [
    `Edited file successfully: ${output.files[0]?.file}`,
    `Replacements: ${output.replacements}`,
    "```diff",
    ...previewLines(oldString, "-"),
    ...previewLines(newString, "+"),
    "```",
  ].join("\n")

// --- Fuzzy replacement chain ---

type Replacer = (content: string, find: string) => Generator<string, void, unknown>

const levenshtein = (a: string, b: string): number => {
  if (a === "" || b === "") return Math.max(a.length, b.length)
  const matrix = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  )
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost)
    }
  }
  return matrix[a.length][b.length]
}

const SimpleReplacer: Replacer = function* (_content, find) {
  yield find
}

const LineTrimmedReplacer: Replacer = function* (content, find) {
  const originalLines = content.split("\n")
  const searchLines = find.split("\n")
  if (searchLines[searchLines.length - 1] === "") searchLines.pop()
  for (let i = 0; i <= originalLines.length - searchLines.length; i++) {
    let matches = true
    for (let j = 0; j < searchLines.length; j++) {
      if (originalLines[i + j].trim() !== searchLines[j].trim()) {
        matches = false
        break
      }
    }
    if (matches) {
      let matchStartIndex = 0
      for (let k = 0; k < i; k++) matchStartIndex += originalLines[k].length + 1
      let matchEndIndex = matchStartIndex
      for (let k = 0; k < searchLines.length; k++) {
        matchEndIndex += originalLines[i + k].length
        if (k < searchLines.length - 1) matchEndIndex += 1
      }
      yield content.substring(matchStartIndex, matchEndIndex)
    }
  }
}

const BlockAnchorReplacer: Replacer = function* (content, find) {
  const originalLines = content.split("\n")
  const searchLines = find.split("\n")
  if (searchLines.length < 3) return
  if (searchLines[searchLines.length - 1] === "") searchLines.pop()
  const firstLineSearch = searchLines[0].trim()
  const lastLineSearch = searchLines[searchLines.length - 1].trim()
  const candidates: Array<{ startLine: number; endLine: number }> = []
  for (let i = 0; i < originalLines.length; i++) {
    if (originalLines[i].trim() !== firstLineSearch) continue
    for (let j = i + 2; j < originalLines.length; j++) {
      if (originalLines[j].trim() === lastLineSearch) {
        candidates.push({ startLine: i, endLine: j })
        break
      }
    }
  }
  if (candidates.length === 0) return
  if (candidates.length === 1) {
    const { startLine, endLine } = candidates[0]
    let matchStartIndex = 0
    for (let k = 0; k < startLine; k++) matchStartIndex += originalLines[k].length + 1
    let matchEndIndex = matchStartIndex
    for (let k = startLine; k <= endLine; k++) {
      matchEndIndex += originalLines[k].length
      if (k < endLine) matchEndIndex += 1
    }
    yield content.substring(matchStartIndex, matchEndIndex)
    return
  }
  let bestMatch: { startLine: number; endLine: number } | null = null
  let maxSimilarity = -1
  for (const candidate of candidates) {
    const { startLine, endLine } = candidate
    const linesToCheck = Math.min(searchLines.length - 2, endLine - startLine - 1)
    let similarity = 0
    if (linesToCheck > 0) {
      for (let j = 1; j < searchLines.length - 1 && j < endLine - startLine; j++) {
        const maxLen = Math.max(originalLines[startLine + j].trim().length, searchLines[j].trim().length)
        if (maxLen === 0) continue
        similarity += 1 - levenshtein(originalLines[startLine + j].trim(), searchLines[j].trim()) / maxLen
      }
      similarity /= linesToCheck
    } else {
      similarity = 1.0
    }
    if (similarity > maxSimilarity) {
      maxSimilarity = similarity
      bestMatch = candidate
    }
  }
  if (maxSimilarity >= 0.3 && bestMatch) {
    const { startLine, endLine } = bestMatch
    let matchStartIndex = 0
    for (let k = 0; k < startLine; k++) matchStartIndex += originalLines[k].length + 1
    let matchEndIndex = matchStartIndex
    for (let k = startLine; k <= endLine; k++) {
      matchEndIndex += originalLines[k].length
      if (k < endLine) matchEndIndex += 1
    }
    yield content.substring(matchStartIndex, matchEndIndex)
  }
}

const WhitespaceNormalizedReplacer: Replacer = function* (content, find) {
  const normalizeWhitespace = (text: string) => text.replace(/\s+/g, " ").trim()
  const normalizedFind = normalizeWhitespace(find)
  const lines = content.split("\n")
  for (let i = 0; i < lines.length; i++) {
    if (normalizeWhitespace(lines[i]) === normalizedFind) yield lines[i]
  }
  const findLines = find.split("\n")
  if (findLines.length > 1) {
    for (let i = 0; i <= lines.length - findLines.length; i++) {
      if (normalizeWhitespace(lines.slice(i, i + findLines.length).join("\n")) === normalizedFind) {
        yield lines.slice(i, i + findLines.length).join("\n")
      }
    }
  }
}

const IndentationFlexibleReplacer: Replacer = function* (content, find) {
  const removeIndentation = (text: string) => {
    const lines = text.split("\n")
    const nonEmpty = lines.filter((l) => l.trim().length > 0)
    if (nonEmpty.length === 0) return text
    const minIndent = Math.min(...nonEmpty.map((l) => (l.match(/^(\s*)/)?.[1].length ?? 0)))
    return lines.map((l) => (l.trim().length === 0 ? l : l.slice(minIndent))).join("\n")
  }
  const normalizedFind = removeIndentation(find)
  const contentLines = content.split("\n")
  const findLines = find.split("\n")
  for (let i = 0; i <= contentLines.length - findLines.length; i++) {
    if (removeIndentation(contentLines.slice(i, i + findLines.length).join("\n")) === normalizedFind) {
      yield contentLines.slice(i, i + findLines.length).join("\n")
    }
  }
}

const EscapeNormalizedReplacer: Replacer = function* (content, find) {
  const unescape = (str: string) =>
    str.replace(/\\(n|t|r|'|"|`|\\|\n|\$)/g, (_, c: string) => {
      const map: Record<string, string> = { n: "\n", t: "\t", r: "\r", "'": "'", '"': '"', "`": "`", "\\": "\\", "\n": "\n", $: "$" }
      return map[c] ?? _
    })
  const unescapedFind = unescape(find)
  if (content.includes(unescapedFind)) yield unescapedFind
  const lines = content.split("\n")
  const findLines = unescapedFind.split("\n")
  for (let i = 0; i <= lines.length - findLines.length; i++) {
    if (unescape(lines.slice(i, i + findLines.length).join("\n")) === unescapedFind) {
      yield lines.slice(i, i + findLines.length).join("\n")
    }
  }
}

const TrimmedBoundaryReplacer: Replacer = function* (content, find) {
  const trimmedFind = find.trim()
  if (trimmedFind === find) return
  if (content.includes(trimmedFind)) yield trimmedFind
  const lines = content.split("\n")
  const findLines = find.split("\n")
  for (let i = 0; i <= lines.length - findLines.length; i++) {
    if (lines.slice(i, i + findLines.length).join("\n").trim() === trimmedFind) {
      yield lines.slice(i, i + findLines.length).join("\n")
    }
  }
}

const ContextAwareReplacer: Replacer = function* (content, find) {
  const findLines = find.split("\n")
  if (findLines.length < 3) return
  if (findLines[findLines.length - 1] === "") findLines.pop()
  const contentLines = content.split("\n")
  const firstLine = findLines[0].trim()
  const lastLine = findLines[findLines.length - 1].trim()
  for (let i = 0; i < contentLines.length; i++) {
    if (contentLines[i].trim() !== firstLine) continue
    for (let j = i + 2; j < contentLines.length; j++) {
      if (contentLines[j].trim() !== lastLine) continue
      const blockLines = contentLines.slice(i, j + 1)
      if (blockLines.length !== findLines.length) continue
      let matchingLines = 0
      let totalNonEmpty = 0
      for (let k = 1; k < blockLines.length - 1; k++) {
        if (blockLines[k].trim().length > 0 || findLines[k].trim().length > 0) {
          totalNonEmpty++
          if (blockLines[k].trim() === findLines[k].trim()) matchingLines++
        }
      }
      if (totalNonEmpty === 0 || matchingLines / totalNonEmpty >= 0.5) {
        yield blockLines.join("\n")
        return
      }
      break
    }
  }
}

const MultiOccurrenceReplacer: Replacer = function* (content, find) {
  let startIndex = 0
  while (true) {
    const index = content.indexOf(find, startIndex)
    if (index === -1) break
    yield find
    startIndex = index + find.length
  }
}

const CLOSEST_MATCH_HINT_MAX_CHARS = 2000

const buildNotFoundError = (content: string, oldString: string): string => {
  const base = `String to replace not found in file. It must match exactly, including whitespace, indentation, and line endings.\nString: ${oldString}`
  for (const replacer of [LineTrimmedReplacer, BlockAnchorReplacer, IndentationFlexibleReplacer, WhitespaceNormalizedReplacer, TrimmedBoundaryReplacer, EscapeNormalizedReplacer, ContextAwareReplacer]) {
    for (const match of replacer(content, oldString)) {
      if (match && match !== oldString && content.includes(match)) {
        const truncated = match.length > CLOSEST_MATCH_HINT_MAX_CHARS ? match.slice(0, CLOSEST_MATCH_HINT_MAX_CHARS) + "\n... (truncated)" : match
        return `${base}\n\nClosest match found in file (note the exact whitespace / indentation / line endings -- resubmit old_string copying this verbatim):\n${truncated}`
      }
    }
  }
  return base
}

const fuzzyReplace = (content: string, oldString: string, newString: string, replaceAll: boolean): string => {
  for (const replacer of [SimpleReplacer, LineTrimmedReplacer, BlockAnchorReplacer, WhitespaceNormalizedReplacer, IndentationFlexibleReplacer, EscapeNormalizedReplacer, TrimmedBoundaryReplacer, ContextAwareReplacer, MultiOccurrenceReplacer]) {
    for (const search of replacer(content, oldString)) {
      const index = content.indexOf(search)
      if (index === -1) continue
      if (replaceAll) return content.replaceAll(search, newString)
      const lastIndex = content.lastIndexOf(search)
      if (index !== lastIndex) continue
      return content.substring(0, index) + newString + content.substring(index + search.length)
    }
  }
  return content
}

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mutation = yield* LocationMutation.Service
    const files = yield* FileMutation.Service
    const fs = yield* FSUtil.Service
    const permission = yield* PermissionV2.Service

    yield* tools
      .register({
        [name]: Tool.withPermission(
          Tool.make({
            description:
              "Replace exact text in one file. Relative paths resolve within the active Location. Absolute paths inside the Location are accepted. Explicit external absolute paths require external_directory approval before edit approval.",
            input: Input,
            output: Output,
            toModelOutput: ({ input, output }) => [
              { type: "text", text: toModelOutput(output, input.oldString, input.newString) },
            ],
            execute: (input, context) => {
              const unableToEdit = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
                effect.pipe(
                  Effect.mapError((error) =>
                    error instanceof FileMutation.StaleContentError
                      ? new ToolFailure({
                          message: "File changed after permission approval. Read it again before editing.",
                        })
                      : new ToolFailure({ message: `Unable to edit ${input.path}` }),
                  ),
                )

              return Effect.gen(function* () {
                const permissionSource = {
                  type: "tool" as const,
                  messageID: context.assistantMessageID,
                  callID: context.toolCallID,
                }
                if (input.oldString === input.newString) {
                  return yield* new ToolFailure({
                    message: "No changes to apply: oldString and newString are identical.",
                  })
                }
                if (input.oldString === "") {
                  return yield* new ToolFailure({
                    message: "oldString must not be empty. Use write to create or overwrite a file.",
                  })
                }

                const target = yield* unableToEdit(mutation.resolve({ path: input.path, kind: "file" }))
                const external = target.externalDirectory
                if (external) {
                  yield* unableToEdit(
                    permission.assert({
                      ...LocationMutation.externalDirectoryPermission(external),
                      sessionID: context.sessionID,
                      agent: context.agent,
                      source: permissionSource,
                    }),
                  )
                }

                yield* unableToEdit(
                  permission.assert({
                    action: "edit",
                    resources: [target.resource],
                    save: ["*"],
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source: permissionSource,
                  }),
                )
                assertFileRead(context, target.canonical, "edit")
                const source = decodeUtf8(yield* unableToEdit(fs.readFile(target.canonical)))
                const ending = detectLineEnding(source.text)
                const oldString = convertToLineEnding(input.oldString, ending)
                const newString = convertToLineEnding(input.newString, ending)
                let replacements = countOccurrences(source.text, oldString)
                let matchedString = oldString
                if (replacements === 0) {
                  const fuzzyResult = fuzzyReplace(source.text, oldString, "", false)
                  if (fuzzyResult !== source.text) {
                    for (const replacer of [SimpleReplacer, LineTrimmedReplacer, BlockAnchorReplacer, WhitespaceNormalizedReplacer, IndentationFlexibleReplacer, EscapeNormalizedReplacer, TrimmedBoundaryReplacer, ContextAwareReplacer]) {
                      for (const search of replacer(source.text, oldString)) {
                        if (search !== oldString && source.text.includes(search)) {
                          matchedString = search
                          replacements = countOccurrences(source.text, search)
                          break
                        }
                      }
                      if (replacements > 0) break
                    }
                  }
                }
                if (replacements === 0) {
                  return yield* new ToolFailure({
                    message: buildNotFoundError(source.text, oldString),
                  })
                }
                if (replacements > 1 && input.replaceAll !== true) {
                  return yield* new ToolFailure({
                    message:
                      "Found multiple exact matches for oldString. Provide more surrounding context or set replaceAll to true.",
                  })
                }

                const replaced =
                  input.replaceAll === true
                    ? source.text.replaceAll(matchedString, newString)
                    : source.text.replace(matchedString, newString)
                const counts = diffLines(source.text, replaced).reduce(
                  (result, item) => ({
                    additions: result.additions + (item.added ? (item.count ?? 0) : 0),
                    deletions: result.deletions + (item.removed ? (item.count ?? 0) : 0),
                  }),
                  { additions: 0, deletions: 0 },
                )
                const next = splitBom(replaced)
                const result = yield* unableToEdit(
                  files.writeIfUnchanged({
                    target,
                    expected: source.content,
                    content: joinBom(next.text, source.bom || next.bom),
                  }),
                )
                return {
                  files: [
                    {
                      file: result.resource,
                      patch: createTwoFilesPatch(result.resource, result.resource, source.text, replaced),
                      status: "modified" as const,
                      ...counts,
                    },
                  ],
                  replacements,
                } satisfies Output
              })
            },
          }),
          "edit",
        ),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/edit",
  layer,
  deps: [ToolRegistry.node, LocationMutation.node, FileMutation.node, FSUtil.node, PermissionV2.node],
})

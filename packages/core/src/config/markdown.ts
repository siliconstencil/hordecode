// Upstream barrel: self-export plus parse(content)/parseOption/sanitize,
// used by config/plugin/agent.ts, config/plugin/command.ts and skill.ts.
// The fork-added `parse` reads a file by path (async) and has a different
// signature, so it is exported as `parseFile` instead of colliding.
export * as ConfigMarkdown from "./markdown"

import { Schema } from "effect"
import { NamedError } from "@opencode-ai/core/util/error"
import matter from "gray-matter"
import { Filesystem } from "../util"

export function parse(content: string) {
  try {
    return matter(content)
  } catch {
    return matter(sanitize(content))
  }
}

export function parseOption(content: string) {
  try {
    return parse(content)
  } catch {
    return undefined
  }
}

// Other coding agents accept unquoted colons in frontmatter values. Retry
// those values as YAML block scalars so existing config files keep working.
export function sanitize(content: string) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return content
  const frontmatter = match[1]
  const result = frontmatter.split(/\r?\n/).flatMap((line) => {
    if (line.trim().startsWith("#") || line.trim() === "" || /^\s+/.test(line)) return [line]
    const entry = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/)
    if (!entry) return [line]
    const value = entry[2].trim()
    if (value === "" || value === ">" || value === "|" || value.startsWith('"') || value.startsWith("'")) return [line]
    if (!value.includes(":")) return [line]
    return [`${entry[1]}: |-`, `  ${value}`]
  })
  return content.replace(frontmatter, () => result.join("\n"))
}

export const FILE_REGEX = /(?<![\w`])@(\.?[^\s`,.]*(?:\.[^\s`,.]+)*)/g
export const SHELL_REGEX = /!`([^`]+)`/g

export function files(template: string) {
  return Array.from(template.matchAll(FILE_REGEX))
}

export function shell(template: string) {
  return Array.from(template.matchAll(SHELL_REGEX))
}

// other coding agents like claude code allow invalid yaml in their
// frontmatter, we need to fallback to a more permissive parser for those cases
export function fallbackSanitization(content: string): string {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return content

  const frontmatter = match[1]
  const lines = frontmatter.split(/\r?\n/)
  const result: string[] = []

  for (const line of lines) {
    // skip comments and empty lines
    if (line.trim().startsWith("#") || line.trim() === "") {
      result.push(line)
      continue
    }

    // skip lines that are continuations (indented)
    if (line.match(/^\s+/)) {
      result.push(line)
      continue
    }

    // match key: value pattern
    const kvMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/)
    if (!kvMatch) {
      result.push(line)
      continue
    }

    const key = kvMatch[1]
    const value = kvMatch[2].trim()

    // skip if value is empty, already quoted, or uses block scalar
    if (value === "" || value === ">" || value === "|" || value.startsWith('"') || value.startsWith("'")) {
      result.push(line)
      continue
    }

    // if value contains a colon, convert to block scalar
    if (value.includes(":")) {
      result.push(`${key}: |-`)
      result.push(`  ${value}`)
      continue
    }

    result.push(line)
  }

  const processed = result.join("\n")
  return content.replace(frontmatter, () => processed)
}

export async function parseFile(filePath: string) {
  const template = await Filesystem.readText(filePath)

  try {
    const md = matter(template)
    return md
  } catch {
    try {
      return matter(fallbackSanitization(template))
    } catch (err) {
      throw new FrontmatterError(
        {
          path: filePath,
          message: `${filePath}: Failed to parse YAML frontmatter: ${err instanceof Error ? err.message : String(err)}`,
        },
        { cause: err },
      )
    }
  }
}

export const FrontmatterError = NamedError.create("ConfigFrontmatterError", {
  path: Schema.String,
  message: Schema.String,
})

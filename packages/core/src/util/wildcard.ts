export * as Wildcard from "./wildcard"

import { sortBy, pipe } from "remeda"

export function match(str: string, pattern: string) {
  if (str) str = str.replaceAll("\\", "/")
  if (pattern) pattern = pattern.replaceAll("\\", "/")
  // Handle trailing " *" as optional (so "ls *" matches "ls" and "ls -la")
  // Diverges from v0.1.5 which used RegExp(".*") and was ReDoS-prone;
  // linear two-pointer matcher below is O(n*m) worst-case without backtracking blowup.
  if (pattern.endsWith(" *")) {
    const base = pattern.slice(0, -2)
    if (linearMatch(str, base)) return true
  }
  return linearMatch(str, pattern)
}

function linearMatch(str: string, pattern: string): boolean {
  const win32 = process.platform === "win32"
  if (win32) {
    str = str.toLowerCase()
    pattern = pattern.toLowerCase()
  }
  let s = 0
  let p = 0
  let star = -1
  let sTmp = -1
  while (s < str.length) {
    // Star must be checked before literal match: a "*" pattern must consume
    // any leading characters including a literal "*" in the input (e.g. glob
    // pattern "**/*.txt" must match the "*" rule). Checking literal first
    // consumed the star itself and misclassified it.
    if (p < pattern.length && pattern[p] === "*") {
      star = p
      sTmp = s
      p++
    } else if (p < pattern.length && (pattern[p] === "?" || pattern[p] === str[s])) {
      s++
      p++
    } else if (star !== -1) {
      p = star + 1
      sTmp++
      s = sTmp
    } else {
      return false
    }
  }
  while (p < pattern.length && pattern[p] === "*") p++
  return p === pattern.length
}

export function all(input: string, patterns: Record<string, any>) {
  const sorted = pipe(patterns, Object.entries, sortBy([([key]) => key.length, "asc"], [([key]) => key, "asc"]))
  let result = undefined
  for (const [pattern, value] of sorted) {
    if (match(input, pattern)) {
      result = value
      continue
    }
  }
  return result
}

export function allStructured(input: { head: string; tail: string[] }, patterns: Record<string, any>) {
  const sorted = pipe(patterns, Object.entries, sortBy([([key]) => key.length, "asc"], [([key]) => key, "asc"]))
  let result = undefined
  for (const [pattern, value] of sorted) {
    const parts = pattern.split(/\s+/)
    if (!match(input.head, parts[0])) continue
    if (parts.length === 1 || matchSequence(input.tail, parts.slice(1))) {
      result = value
      continue
    }
  }
  return result
}

function matchSequence(items: string[], patterns: string[]): boolean {
  if (patterns.length === 0) return true
  const [pattern, ...rest] = patterns
  if (pattern === "*") return matchSequence(items, rest)
  for (let i = 0; i < items.length; i++) {
    if (match(items[i], pattern) && matchSequence(items.slice(i + 1), rest)) {
      return true
    }
  }
  return false
}

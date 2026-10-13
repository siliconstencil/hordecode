import { Flag } from "@opencode-ai/core/flag/flag"
import type { Info } from "./index"
import { localizedAliases } from "./localized-alias"

export interface SearchResult {
  skill_id: string
  name: string
  score: number
  reason: string
}

export interface SkillSearchModel {
  id?: string
  modelID?: string
  name?: string
  family?: string
  api?: { id?: string }
}

export function isHarnessSkill(skill: Info) {
  return (
    skill.name === "harness-next" ||
    skill.name.startsWith("harness:")
  )
}

export function isSkillSearchDisabled(model: SkillSearchModel | undefined) {
  if (!model) return false
  const pattern = /(^|[^a-z0-9])(claude|gpt)($|[^a-z0-9])/i
  return [model.id, model.modelID, model.api?.id, model.name, model.family].some(
    (value) => value !== undefined && pattern.test(value),
  )
}

function normalize(value: string) {
  return value.toLocaleLowerCase().trim()
}

function explicitlyMentions(query: string, value: string) {
  if (!value) return false
  const normalizedQuery = normalize(query)
  const normalizedValue = normalize(value)
  if (normalizedQuery === normalizedValue) return true
  if (/[\u3400-\u9fff]/.test(normalizedValue)) return normalizedQuery.includes(normalizedValue)
  return new RegExp(`(^|[^a-z0-9])${escapeRegex(normalizedValue)}($|[^a-z0-9])`).test(normalizedQuery)
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

const STOP_WORDS = new Set([
  "a",
  "action",
  "an",
  "and",
  "audience",
  "for",
  "from",
  "input",
  "of",
  "output",
  "the",
  "to",
  "with",
])

function tokenize(value: string) {
  const normalized = normalize(value)
    .replace(/([\u3400-\u9fff])/g, " $1 ")
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .filter((token) => !STOP_WORDS.has(token))
  return normalized.flatMap((token) => {
    if (/^[\u3400-\u9fff]+$/.test(token)) {
      if (token.length === 1) return [token]
      return token.split("").slice(0, -1).map((_, index) => token.slice(index, index + 2))
    }
    if (
      token.length > Flag.HORDECODE_SKILL_SEARCH_STEM_MIN_LENGTH &&
      token.endsWith("s") &&
      !token.endsWith("ss")
    ) {
      return [token.slice(0, -1)]
    }
    return [token]
  })
}

export function searchSkills(query: string, skills: Info[]): SearchResult[] {
  const eligible = skills.filter((skill) => !isHarnessSkill(skill))
  const exact = eligible
    .filter((skill) =>
      [skill.name, ...(skill.aliases ?? []), ...localizedAliases(skill)].some((value) =>
        explicitlyMentions(query, value),
      ),
    )
    .map((skill) => ({
      skill_id: skill.name,
      name: skill.name,
      score: Flag.HORDECODE_SKILL_SEARCH_EXACT_SCORE,
      reason: `The query explicitly mentions the skill ID, name, or alias for ${skill.name}.`,
    }))

  const queryTokens = [...new Set(tokenize(query))]
  const documents = eligible.map((skill) => ({
    skill,
    tokens: tokenize(
      [skill.name, ...(skill.aliases ?? []), ...localizedAliases(skill), skill.description ?? ""].join(
        " ",
      ),
    ),
  }))
  const averageLength = documents.length > 0 ? documents.reduce((sum, doc) => sum + doc.tokens.length, 0) / documents.length : 0

  const scores = documents.map(({ skill, tokens }) => {
    let score = 0
    for (const token of queryTokens) {
      const freq = tokens.filter((docToken) => docToken === token).length
      if (freq === 0) continue
      const df = documents.filter((doc) => doc.tokens.includes(token)).length
      const idf = Math.log(
        1 + (documents.length - df + Flag.HORDECODE_SKILL_SEARCH_BM25_IDF_SMOOTHING) / (df + Flag.HORDECODE_SKILL_SEARCH_BM25_IDF_SMOOTHING),
      )
      const normalizedLength = tokens.length / (averageLength || 1)
      score +=
        idf *
        ((freq * (Flag.HORDECODE_SKILL_SEARCH_BM25_K1 + 1)) /
          (freq +
            Flag.HORDECODE_SKILL_SEARCH_BM25_K1 *
              (1 -
                Flag.HORDECODE_SKILL_SEARCH_BM25_LENGTH_NORMALIZATION +
                Flag.HORDECODE_SKILL_SEARCH_BM25_LENGTH_NORMALIZATION * normalizedLength)))
    }
    return { skill, score }
  })

  const maximum = Math.max(0, ...scores.map(({ score }) => score))
  const bm25 = scores
    .filter(({ score }) => score > 0)
    .toSorted((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
    .map(({ skill, score }) => {
      const matched = queryTokens.filter((token) => tokenize(skill.description ?? "").includes(token))
      const coverage = queryTokens.length > 0 ? matched.length / queryTokens.length : 0
      return {
        skill_id: skill.name,
        name: skill.name,
        score: Number(
          ((score / maximum) * Flag.HORDECODE_SKILL_SEARCH_BM25_SCORE_WEIGHT +
            coverage * Flag.HORDECODE_SKILL_SEARCH_QUERY_COVERAGE_WEIGHT
          ).toFixed(Flag.HORDECODE_SKILL_SEARCH_SCORE_PRECISION)),
        reason: `The skill description matches these query terms: ${matched.join(", ")}.`,
      }
    })

  const exactIDs = new Set(exact.map((result) => result.skill_id))
  return [...exact, ...bm25.filter((result) => !exactIDs.has(result.skill_id))].slice(
    0,
    Flag.HORDECODE_SKILL_SEARCH_MAX_RESULTS,
  )
}

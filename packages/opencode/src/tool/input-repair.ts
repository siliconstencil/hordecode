// FORK_DELTA. Scalar repair follows opencode 2.2.5
// packages/core/src/plugin/tool-input-repair.ts:89-110 (numeric/integer/boolean strings are parsed
// only when the schema node has that exact type). Hordecode applies only that scalar subset at the
// tool parameter boundary; the reference's container, placeholder and extra-key repairs are not ported.
const MAX_DEPTH = 6

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function resolveReference(ref: string, root: unknown): unknown {
  if (!isRecord(root)) return undefined
  const definitions = ref.startsWith("#/$defs/")
    ? root.$defs
    : ref.startsWith("#/definitions/")
      ? root.definitions
      : undefined
  if (!isRecord(definitions)) return undefined
  const name = ref
    .slice(ref.lastIndexOf("/") + 1)
    .replaceAll("~1", "/")
    .replaceAll("~0", "~")
  return Object.hasOwn(definitions, name) ? definitions[name] : undefined
}

/**
 * Parse a JSON number string only where the schema says the field is a number or integer.
 * Anything the schema cannot prove (no type, a union with a string branch, a non-finite value)
 * is returned untouched, so the normal schema decode still reports the original error.
 */
export function repairScalarStrings(value: unknown, schema: unknown, root: unknown = schema, depth = 0): unknown {
  if (!isRecord(schema) || depth > MAX_DEPTH) return value

  if (typeof schema.$ref === "string") {
    const target = resolveReference(schema.$ref, root)
    return target === undefined ? value : repairScalarStrings(value, target, root, depth + 1)
  }

  if (Array.isArray(schema.type)) {
    if (value === null && schema.type.includes("null")) return value
    if (schema.type.includes(typeof value)) return value
    const types = schema.type.filter((type) => type !== "null")
    return types.length === 1 ? repairScalarStrings(value, { ...schema, type: types[0] }, root, depth + 1) : value
  }

  if (schema.type === undefined) {
    if (Array.isArray(schema.enum) || "const" in schema) return value
    if (Array.isArray(schema.anyOf) && Array.isArray(schema.oneOf)) return value
    const branches = Array.isArray(schema.anyOf) ? schema.anyOf : Array.isArray(schema.oneOf) ? schema.oneOf : undefined
    if (!branches || value === null) return value
    if (branches.some((branch) => isRecord(branch) && branch.type === typeof value)) return value
    const candidates = branches.filter((branch) => isRecord(branch) && branch.type !== "null")
    return candidates.length === 1 ? repairScalarStrings(value, candidates[0], root, depth + 1) : value
  }

  if (schema.type === "number" || schema.type === "integer") {
    if (typeof value !== "string" || value.trim() === "") return value
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) return value
    if (schema.type === "integer" && !Number.isSafeInteger(parsed)) return value
    return parsed
  }

  if (schema.type === "boolean") {
    return value === "true" ? true : value === "false" ? false : value
  }

  if (schema.type === "object" && isRecord(value)) {
    const properties = isRecord(schema.properties) ? schema.properties : {}
    const additional = isRecord(schema.additionalProperties) ? schema.additionalProperties : undefined
    let result: Record<string, unknown> | undefined
    for (const key of Object.keys(value)) {
      const property = Object.hasOwn(properties, key) ? properties[key] : additional
      if (!isRecord(property)) continue
      const repaired = repairScalarStrings(value[key], property, root, depth + 1)
      if (repaired !== value[key]) {
        result ??= { ...value }
        result[key] = repaired
      }
    }
    return result ?? value
  }

  if (schema.type === "array" && Array.isArray(value)) {
    const tuple = Array.isArray(schema.prefixItems) ? schema.prefixItems : undefined
    const items = tuple ? undefined : Array.isArray(schema.items) ? schema.items : isRecord(schema.items) ? schema.items : undefined
    if (!tuple && !items) return value
    let result: unknown[] | undefined
    for (let index = 0; index < value.length; index++) {
      const member = tuple
        ? (tuple[index] ?? (isRecord(schema.items) ? schema.items : undefined))
        : Array.isArray(items)
          ? items[index]
          : items
      if (!isRecord(member)) continue
      const repaired = repairScalarStrings(value[index], member, root, depth + 1)
      if (repaired !== value[index]) {
        result ??= [...value]
        result[index] = repaired
      }
    }
    return result ?? value
  }

  return value
}

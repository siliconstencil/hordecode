/**
 * Single read point for the memory write switch (default ENABLED).
 *
 * The double negative is deliberate: the default state is "write memory",
 * and only a literal `true` for `memory.disable_write` turns it off.
 * Anything else -- missing field, malformed non-boolean -- degrades to enabled.
 *
 * The parameter is structural on purpose so plugin-SDK config objects
 * (which carry only the fields they expose) work without casting.
 */

export type MemoryWriteConfig = { memory?: { disable_write?: boolean } }

export function isMemoryWriteEnabled(cfg: MemoryWriteConfig | undefined): boolean {
  return cfg?.memory?.disable_write !== true
}

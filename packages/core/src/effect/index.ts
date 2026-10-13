// Re-export upstream-native Effect utils that upstream delta files depend on.
// This barrel existed at upstream v1.14.20 (upstream fork base), was deleted
// by upstream before v1.17.18 (restructured into core/effect/), but is
// still imported by 134 delta files. This is a Category 4 UDA
// (Upstream-Deleted Ancestor) barrel -- see 1/inventory/uda-census.md.

export * as Runner from "./runner"
export * as Observability from "./observability"
export * as EffectLogger from "./logger"
export * as InstanceState from "./instance-state"
export * as EffectBridge from "./bridge"

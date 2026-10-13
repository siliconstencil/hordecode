/**
 * V2-to-V1 branded-type bridge for ProviderID and ModelID.
 *
 * Opencode's Provider.Interface.defaultModel() returns V2 branded types
 * (ProviderV2.ID, ModelV2.ID from @opencode-ai/schema/provider and
 * @opencode-ai/schema/model), while supervisor.spawn() and ForkContext.model
 * expect V1 branded types (ProviderID, ModelID from
 * @opencode-ai/core/provider/schema).
 *
 * Both are structurally strings -- only the Effect/Schema brand differs.
 * This is a documented type-level seam (a narrow, justified,
 * runtime-safety-confirmed cast; see packages/core/src/config/config.ts
 * for the precedent), not a
 * runtime concern.
 *
 * Usage:
 *   import { toLegacyProviderID, toLegacyModelID } from "@opencode-ai/core/provider/bridge"
 *   const model = yield* provider.defaultModel()
 *   supervisor.spawn({ ..., model: { providerID: toLegacyProviderID(model.providerID), modelID: toLegacyModelID(model.modelID) } })
 */

import type { ProviderID, ModelID } from "./schema"
import type { ID as ProviderV2ID } from "@opencode-ai/schema/provider"
import type { ID as ModelV2ID } from "@opencode-ai/schema/model"

export function toLegacyProviderID(id: ProviderV2ID): ProviderID {
  return id as unknown as ProviderID
}

export function toLegacyModelID(id: ModelV2ID): ModelID {
  return id as unknown as ModelID
}

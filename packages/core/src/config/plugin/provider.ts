export * as ConfigProviderPlugin from "./provider"

import { define } from "../../plugin/internal"
import { Effect } from "effect"
import { Config } from "../../config"
import { ModelV2 } from "../../model"
import { ProviderV2 } from "../../provider"

export const Plugin = define({
  id: "config-provider",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    yield* ctx.integration.transform(
      Effect.fn(function* (integrations) {
        const files = (yield* config.entries()).filter((entry): entry is Config.Document => entry.type === "document")
        const configuredIntegrations = new Set(
          files.flatMap((file) =>
            Object.entries(file.info.providers ?? {}).flatMap(([id, provider]) =>
              provider.env === undefined ? [] : [id],
            ),
          ),
        )
        for (const file of files) {
          for (const [id, item] of Object.entries(file.info.providers ?? {})) {
            const integrationID = id
            if (!configuredIntegrations.has(id) && !integrations.get(integrationID)) continue
            integrations.update(integrationID, (integration) => {
              integration.name = item.name ?? integration.name
            })
            if (item.env !== undefined) {
              integrations.method.update({
                integrationID,
                method: { type: "env", names: [...item.env] },
              })
            }
          }
        }
      }),
    )

    yield* ctx.catalog.transform(
      Effect.fn(function* (catalog) {
        const entries = yield* config.entries()
        const files = entries.filter((entry): entry is Config.Document => entry.type === "document")
        const configuredDefault = Config.latest(entries, "model")
        if (configuredDefault !== undefined) {
          const model = ModelV2.parse(configuredDefault)
          catalog.model.default.set(model.providerID, model.modelID)
        }
        for (const file of files) {
          for (const [id, item] of Object.entries(file.info.providers ?? {})) {
            const providerID = id
            catalog.provider.update(providerID, (provider) => {
              if (item.name !== undefined) provider.name = item.name
              if (item.api !== undefined) provider.api = { ...item.api }
              if (item.request !== undefined) {
                Object.assign(provider.request.headers, item.request.headers)
                Object.assign(provider.request.body, item.request.body)
              }
            })
            for (const [id, config] of Object.entries(item.models ?? {})) {
              catalog.model.update(providerID, id, (model) => {
                if (config.family !== undefined) model.family = config.family
                if (config.name !== undefined) model.name = config.name
                if (config.api !== undefined) model.api = { ...model.api, ...config.api }
                if (config.capabilities !== undefined) {
                  model.capabilities = {
                    tools: config.capabilities.tools,
                    input: [...config.capabilities.input],
                    output: [...config.capabilities.output],
                  }
                }
                if (config.request !== undefined) {
                  Object.assign(model.request.headers, config.request.headers)
                  Object.assign(model.request.body, config.request.body)
                  if (config.request.variant !== undefined) model.request.variant = config.request.variant
                }
                if (config.variants !== undefined) {
                  for (const [id, options] of Object.entries(config.variants)) {
                    const variantID = ModelV2.VariantID.make(id)
                    const headers = options.headers as Record<string, string> | undefined
                    const body = options.body as Record<string, unknown> | undefined
                    const existing = model.variants.find((variant) => variant.id === variantID)
                    if (existing === undefined) {
                      model.variants.push({ id: variantID, headers: headers ?? {}, body: body ?? {} })
                      continue
                    }
                    if (headers !== undefined) Object.assign(existing.headers, headers)
                    if (body !== undefined) Object.assign(existing.body, body)
                  }
                }
                if (config.cost !== undefined) {
                  const existing = model.cost[0]
                  const base = {
                    input: config.cost.input ?? existing?.input ?? 0,
                    output: config.cost.output ?? existing?.output ?? 0,
                    cache: {
                      read: config.cost.cache_read ?? existing?.cache?.read ?? 0,
                      write: config.cost.cache_write ?? existing?.cache?.write ?? 0,
                    },
                  }
                  if (config.cost.context_over_200k) {
                    model.cost = [
                      base,
                      {
                        tier: { type: "context" as const, size: 200_000 },
                        input: config.cost.context_over_200k.input,
                        output: config.cost.context_over_200k.output,
                        cache: {
                          read: config.cost.context_over_200k.cache_read ?? 0,
                          write: config.cost.context_over_200k.cache_write ?? 0,
                        },
                      },
                    ]
                  } else {
                    model.cost = [base]
                  }
                }
                if (config.disabled !== undefined) model.enabled = !config.disabled
                if (config.limit !== undefined) model.limit = { ...model.limit, ...config.limit }
              })
            }
          }
        }
      }),
    )
  }),
})

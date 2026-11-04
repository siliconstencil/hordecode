export type CostModel = { cost?: { input: number; output: number } }

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

// A cost below one cent rounds to $0.00 at two decimals, which reads as free.
export function formatUsd(value: number): string {
  if (value > 0 && value < 0.01) return "<$0.01"
  return money.format(value)
}

// Catalog prices arrive as zeros both for flat-plan models and for models with no
// price at all; the provider id is the only signal the TUI keeps that separates them.
export function formatCost(value: number, model?: CostModel, providerID?: string): string {
  if (value > 0) return formatUsd(value)
  const unpriced = model?.cost === undefined || (model.cost.input === 0 && model.cost.output === 0)
  if (unpriced) return providerID?.endsWith("-coding-plan") ? "plan" : "n/a"
  return money.format(value)
}

import * as Bwrap from "./bwrap"
import * as Landlock from "./landlock"
import { systemDeps } from "./system"
import type { Command, Deps, Detection, Driver, DriverChoice, DriverName, Mode, Policy } from "./types"

export type { Command, Deps, Detection, Driver, DriverChoice, DriverName, Mode, Policy } from "./types"
export { makePolicy, systemLayout, assertSafe, PolicyError } from "./policy"
export { Bwrap, Landlock }

export class UnavailableError extends Error {
  readonly _tag = "SandboxUnavailableError"
  constructor(readonly detections: Partial<Record<DriverName, Detection>>) {
    super(
      "sandbox mode is required but no driver is available: " +
        Object.entries(detections)
          .map(([name, d]) => `${name}: ${d?.reason ?? "unknown"}${d?.detail ? ` (${d.detail})` : ""}`)
          .join("; ") +
        ". Install bubblewrap (for example `apt install bubblewrap`) or run on a kernel with Landlock.",
    )
  }
}

export interface Resolution {
  mode: Mode
  driver: Driver | undefined
  detections: Partial<Record<DriverName, Detection>>
  degraded: string[]
}

export const createDrivers = (deps: Deps = systemDeps): Driver[] => [Bwrap.create(deps), Landlock.create(deps)]

// off: no detection. auto: first available driver in the order bwrap, landlock, else no sandbox.
// required: like auto, but no available driver is an error.
export async function resolve(input: { mode: Mode; driver?: DriverChoice; drivers?: Driver[] }): Promise<Resolution> {
  const detections: Partial<Record<DriverName, Detection>> = {}
  if (input.mode === "off") return { mode: "off", driver: undefined, detections, degraded: [] }
  const choice = input.driver ?? "auto"
  const candidates = (input.drivers ?? createDrivers()).filter((d) => choice === "auto" || d.name === choice)
  for (const driver of candidates) {
    const detection = await driver.detect()
    detections[driver.name] = detection
    if (detection.available) {
      return { mode: input.mode, driver, detections, degraded: detection.degraded ?? [] }
    }
  }
  if (input.mode === "required") throw new UnavailableError(detections)
  return { mode: input.mode, driver: undefined, detections, degraded: [] }
}

// undefined means: run the command as before.
export function wrapCommand(resolution: Resolution, input: { shell: string; command: string; policy: Policy }) {
  return resolution.driver?.wrap(input)
}

export * as Sandbox from "."

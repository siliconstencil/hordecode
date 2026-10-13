// Late-bound reference to the Supervisor service implementation.
//
// SessionCheckpoint.tryStartCheckpointWriter needs to spawn the checkpoint-writer
// subagent. Wiring `Supervisor.Service` as a normal Layer dependency here would
// create a layer cycle (Supervisor -> SessionPrompt -> SessionCheckpoint -> Supervisor)
// that Effect cannot resolve. Instead, `Supervisor.layer` populates this module-
// local reference on initialisation, and SessionCheckpoint reads from it at
// call time. The cycle is broken at the type level because SessionCheckpoint
// no longer declares a `Supervisor.Service` requirement.
//
// Render-only paths (rebuild context, FileWatcher) never call tryStartCheckpointWriter,
// so a missing `current` is treated as a runtime guard rather than a hard
// invariant.
import type { Interface as SupervisorInterface } from "./spawn"

export const spawnRef: { current: SupervisorInterface | undefined } = { current: undefined }

import type { TuiPlugin } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { DialogStepLimit } from "../../component/dialog-step-limit"

const id = "internal:step-limit"

// Fork addition (FORK_ONLY). Adds the "Step limit" entry to the command palette (ctrl+p); the
// dialog writes the root-level `steps` key of the main user config (hordecode.json).
const tui: TuiPlugin = async (api) => {
  api.keymap.registerLayer({
    commands: [
      {
        name: "step.limit",
        title: "Step limit",
        category: "System",
        namespace: "palette",
        run() {
          api.ui.dialog.replace(() => <DialogStepLimit />)
        },
      },
    ],
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin

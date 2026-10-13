import { TuiConfig } from "@opencode-ai/tui/config"
import { createSimpleContext } from "./helper"

export const { use: useTuiConfig, provider: TuiConfigProvider } = createSimpleContext({
  name: "TuiConfig",
  init: (props: { config: TuiConfig.Info }) => {
    return props.config
  },
})

import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import HomeFooter from "./home/footer"
import HomeTips from "./home/tips"
import SidebarCwd from "./sidebar/cwd"
import SidebarFiles from "./sidebar/files"
import SidebarFooter from "./sidebar/footer"
import SidebarGoal from "./sidebar/goal"
import SidebarInstructions from "./sidebar/instructions"
import SidebarLsp from "./sidebar/lsp"
import SidebarMcp from "./sidebar/mcp"
import SidebarSupervisor from "./sidebar/supervisor"
import SidebarCron from "./sidebar/cron"
import SidebarTask from "./sidebar/task"
import SidebarTelemetry from "./sidebar/telemetry"
import SidebarTiming from "./sidebar/timing"
import SidebarTodo from "./sidebar/todo"
import DiffViewer from "./system/diff-viewer"
import Notifications from "./system/notifications"
import PluginManager from "./system/plugins"
import WhichKey from "./system/which-key"

export type BuiltinTuiPlugin = Omit<TuiPluginModule, "id"> & {
  id: string
  tui: TuiPlugin
  enabled?: boolean
}

export function createBuiltinPlugins(options: { experimentalEventSystem: boolean }): BuiltinTuiPlugin[] {
  return [
    HomeFooter,
    HomeTips,
    SidebarCwd,
    SidebarGoal,
    SidebarInstructions,
    SidebarSupervisor,
    SidebarMcp,
    SidebarLsp,
    SidebarCron,
    SidebarTask,
    SidebarTelemetry,
    SidebarTiming,
    SidebarTodo,
    SidebarFiles,
    SidebarFooter,
    Notifications,
    PluginManager,
    WhichKey,
    DiffViewer,
  ]
}

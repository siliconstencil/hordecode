import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, For, Show, createSignal } from "solid-js"
import { TodoItem } from "../../component/todo-item"
import { currentRequestStart } from "./task"

const id = "internal:sidebar-todo"

// Hordecode: a plan written before the current user message is stale until the agent
// rewrites it, so it is not rendered (upstream 1.19.5 sidebar/todo.tsx:12-14 renders the
// stored list unconditionally). The todo rows stay in storage and the tool history.
export function todoPanelVisible(input: {
  todos: ReadonlyArray<{ status: string }>
  taskCount: number
  requestStart?: number
  updatedAt?: number
}): boolean {
  if (input.taskCount > 0) return false
  if (!input.todos.some((item) => item.status !== "completed")) return false
  if (input.requestStart !== undefined && (input.updatedAt ?? 0) < input.requestStart) return false
  return true
}

function View(props: { api: TuiPluginApi; session_id: string }) {
  const [open, setOpen] = createSignal(true)
  const theme = () => props.api.theme.current
  const list = createMemo(() => props.api.state.session.todo(props.session_id))
  const tasks = createMemo(() => props.api.state.session.task(props.session_id))
  const requestStart = createMemo(() => currentRequestStart(props.api.state.session.messages(props.session_id)))
  const updatedAt = createMemo(() => props.api.state.session.todoUpdatedAt(props.session_id))
  const show = createMemo(() =>
    todoPanelVisible({
      todos: list(),
      taskCount: tasks().length,
      requestStart: requestStart(),
      updatedAt: updatedAt(),
    }),
  )

  return (
    <Show when={show()}>
      <box>
        <box flexDirection="row" gap={1} onMouseDown={() => list().length > 2 && setOpen((x) => !x)}>
          <Show when={list().length > 2}>
            <text fg={theme().text}>{open() ? "▼" : "▶"}</text>
          </Show>
          <text fg={theme().text}>
            <b>Todo</b>
          </text>
        </box>
        <Show when={list().length <= 2 || open()}>
          <For each={list()}>{(item) => <TodoItem status={item.status} content={item.content} />}</For>
        </Show>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 401,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin & { id: string } = {
  id,
  tui,
}

export default plugin

import { createContext, type JSX, useContext } from "solid-js"
import { read, write } from "../clipboard"

export type ClipboardContent = Readonly<{ data: string; mime: string }>
export type ClipboardService = Readonly<{
  read?(): Promise<ClipboardContent | undefined>
  write?(text: string): Promise<void>
}>
const clipboard = { read, write }
const ClipboardContext = createContext<ClipboardService>(clipboard)

export function ClipboardProvider(props: { value?: ClipboardService; children: JSX.Element }) {
  return <ClipboardContext.Provider value={props.value ?? clipboard}>{props.children}</ClipboardContext.Provider>
}

export function useClipboard() {
  return useContext(ClipboardContext)
}

export function ClipboardCopy(): { copy: (text: string) => Promise<void> } {
  const clip = useClipboard()
  return {
    copy: async (text: string) => {
      await clip.write?.(text)
      await clip.read?.()
    },
  }
}

export function ClipboardCopyComponent(props: { value: string; children?: JSX.Element }) {
  const clip = useClipboard()
  return (
    <span
      // @ts-expect-error span element from opentui/solid may not include onClick in its props type
      onClick={() => clip.write?.(props.value)}
      style={{ cursor: "pointer", textDecoration: "underline" }}
    >
      {props.children ?? props.value}
    </span>
  )
}

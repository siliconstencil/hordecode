import { AwsClient } from "aws4fetch"
import { lazy } from "@opencode-ai/core/util/lazy"

export namespace Storage {
  export interface Adapter {
    read(path: string): Promise<string | undefined>
    write(path: string, value: string): Promise<void>
    remove(path: string): Promise<void>
    list(options?: { prefix?: string; limit?: number; after?: string; before?: string }): Promise<string[]>
  }

  function createAdapter(client: AwsClient, endpoint: string, bucket: string): Adapter {
    const base = `${endpoint}/${bucket}`
    return {
      async read(path: string): Promise<string | undefined> {
        const response = await client.fetch(`${base}/${path}`)
        if (response.status === 404) return undefined
        if (!response.ok) throw new Error(`Failed to read ${path}: ${response.status}`)
        return response.text()
      },

      async write(path: string, value: string): Promise<void> {
        const response = await client.fetch(`${base}/${path}`, {
          method: "PUT",
          body: value,
          headers: {
            "Content-Type": "application/json",
          },
        })
        if (!response.ok) throw new Error(`Failed to write ${path}: ${response.status}`)
      },

      async remove(path: string): Promise<void> {
        const response = await client.fetch(`${base}/${path}`, {
          method: "DELETE",
        })
        if (!response.ok) throw new Error(`Failed to remove ${path}: ${response.status}`)
      },

      async list(options?: { prefix?: string; limit?: number; after?: string; before?: string }): Promise<string[]> {
        const prefix = options?.prefix || ""
        const params = new URLSearchParams({ "list-type": "2", prefix })
        if (options?.limit) params.set("max-keys", options.limit.toString())
        if (options?.after) {
          const afterPath = prefix + options.after + ".json"
          params.set("start-after", afterPath)
        }
        const response = await client.fetch(`${base}?${params}`)
        if (!response.ok) throw new Error(`Failed to list ${prefix}: ${response.status}`)
        const xml = await response.text()
        const keys: string[] = []
        const regex = /<Key>([^<]+)<\/Key>/g
        let match
        while ((match = regex.exec(xml)) !== null) {
          keys.push(match[1])
        }
        if (options?.before) {
          const beforePath = prefix + options.before + ".json"
          return keys.filter((key) => key < beforePath)
        }
        return keys
      },
    }
  }

  function s3(): Adapter {
    const bucket = process.env.HORDECODE_STORAGE_BUCKET ?? process.env.OPENCODE_STORAGE_BUCKET!
    const region = process.env.HORDECODE_STORAGE_REGION || process.env.OPENCODE_STORAGE_REGION || "us-east-1"
    const client = new AwsClient({
      region,
      accessKeyId: process.env.HORDECODE_STORAGE_ACCESS_KEY_ID ?? process.env.OPENCODE_STORAGE_ACCESS_KEY_ID!,
      secretAccessKey: process.env.HORDECODE_STORAGE_SECRET_ACCESS_KEY ?? process.env.OPENCODE_STORAGE_SECRET_ACCESS_KEY!,
    })
    return createAdapter(client, `https://s3.${region}.amazonaws.com`, bucket)
  }

  function r2() {
    const accountId = process.env.HORDECODE_STORAGE_ACCOUNT_ID ?? process.env.OPENCODE_STORAGE_ACCOUNT_ID!
    const client = new AwsClient({
      accessKeyId: process.env.HORDECODE_STORAGE_ACCESS_KEY_ID ?? process.env.OPENCODE_STORAGE_ACCESS_KEY_ID!,
      secretAccessKey: process.env.HORDECODE_STORAGE_SECRET_ACCESS_KEY ?? process.env.OPENCODE_STORAGE_SECRET_ACCESS_KEY!,
    })
    return createAdapter(
      client,
      `https://${accountId}.r2.cloudflarestorage.com`,
      process.env.HORDECODE_STORAGE_BUCKET ?? process.env.OPENCODE_STORAGE_BUCKET!,
    )
  }

  function memory(): Adapter {
    const store = new Map<string, string>()
    const endpoint = "https://memory.local"
    const bucket = "bucket"
    interface MockClient {
      fetch(url: string, init?: { method?: string; body?: string }): Promise<{ status: number; ok: boolean; text(): Promise<string> }>
    }
    const client: MockClient = {
      async fetch(url: string, init?: { method?: string; body?: string }) {
        const base = `${endpoint}/${bucket}`
        const [pathPart, queryPart] = url.slice(base.length).split("?")
        const method = init?.method ?? "GET"
        if (method === "PUT") {
          store.set(pathPart.slice(1), init!.body as string)
          return { status: 200, ok: true, text: async () => "" }
        }
        if (method === "DELETE") {
          store.delete(pathPart.slice(1))
          return { status: 200, ok: true, text: async () => "" }
        }
        if (queryPart) {
          const params = new URLSearchParams(queryPart)
          const prefix = params.get("prefix") ?? ""
          const startAfter = params.get("start-after")
          const maxKeys = params.get("max-keys")
          let keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort()
          if (startAfter) keys = keys.filter((k) => k > startAfter)
          if (maxKeys) keys = keys.slice(0, Number(maxKeys))
          const xml = `<?xml version="1.0"?><ListBucketResult>${keys
            .map((k) => `<Contents><Key>${k}</Key></Contents>`)
            .join("")}</ListBucketResult>`
          return { status: 200, ok: true, text: async () => xml }
        }
        const value = store.get(pathPart.slice(1))
        if (value === undefined) return { status: 404, ok: false, text: async () => "" }
        return { status: 200, ok: true, text: async () => value }
      },
    }
    return createAdapter(client as AwsClient, endpoint, bucket)
  }

  const adapter = lazy(() => {
    const type = process.env.HORDECODE_STORAGE_ADAPTER ?? process.env.OPENCODE_STORAGE_ADAPTER
    if (type === "r2") return r2()
    if (type === "s3") return s3()
    if (type === "memory") return memory()
    throw new Error("No storage adapter configured")
  })

  function resolve(key: string[]) {
    return key.join("/") + ".json"
  }

  export async function read<T>(key: string[]) {
    const result = await adapter().read(resolve(key))
    if (!result) return undefined
    return JSON.parse(result) as T
  }

  export function write<T>(key: string[], value: T) {
    return adapter().write(resolve(key), JSON.stringify(value))
  }

  export function remove(key: string[]) {
    return adapter().remove(resolve(key))
  }

  export async function list(options?: { prefix?: string[]; limit?: number; after?: string; before?: string }) {
    const p = options?.prefix ? options.prefix.join("/") + (options.prefix.length ? "/" : "") : ""
    const result = await adapter().list({
      prefix: p,
      limit: options?.limit,
      after: options?.after,
      before: options?.before,
    })
    return result.map((x) => x.replace(/\.json$/, "").split("/"))
  }

  export async function update<T>(key: string[], fn: (draft: T) => void) {
    const val = await read<T>(key)
    if (!val) throw new Error("Not found")
    fn(val)
    await write(key, val)
    return val
  }
}

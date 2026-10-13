import { App } from "@slack/bolt"
import { createOpencode, type ToolPart } from "@opencode-ai/sdk"

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
})

console.log("🔧 Bot configuration:")
console.log("- Bot token present:", !!process.env.SLACK_BOT_TOKEN)
console.log("- Signing secret present:", !!process.env.SLACK_SIGNING_SECRET)
console.log("- App token present:", !!process.env.SLACK_APP_TOKEN)

console.log("🚀 Starting opencode server...")
const opencode = await createOpencode({
  port: 0,
})
console.log("✅ Opencode server ready")

const SESSION_TTL_MS = 30 * 60 * 1000
const SESSION_MAX_COUNT = 500
type OpencodeType = Awaited<ReturnType<typeof createOpencode>>
const sessions = new Map<
  string,
  {
    client: OpencodeType["client"]
    server: OpencodeType["server"]
    sessionId: string
    channel: string
    thread: string
    lastSeenAt: number
  }
>()

const pruneSessions = (now: number) => {
  sessions.forEach((session, key) => {
    if (now - session.lastSeenAt > SESSION_TTL_MS) sessions.delete(key)
  })
  if (sessions.size <= SESSION_MAX_COUNT) return
  const overflow = sessions.size - SESSION_MAX_COUNT
  Array.from(sessions.entries())
    .sort((left, right) => left[1].lastSeenAt - right[1].lastSeenAt)
    .slice(0, overflow)
    .forEach(([key]) => {
      sessions.delete(key)
    })
}

const touchSession = (sessionKey: string, now: number) => {
  const session = sessions.get(sessionKey)
  if (!session) return
  session.lastSeenAt = now
}

async function subscribeLoop(): Promise<void> {
  const events = await opencode.client.event.subscribe()
  for await (const event of events.stream) {
    if (event.type === "message.part.updated") {
      const part = event.properties.part
      if (part.type === "tool") {
        // Find the session for this tool update
        const now = Date.now()
        pruneSessions(now)
        for (const [sessionKey, session] of sessions.entries()) {
          if (session.sessionId === part.sessionID) {
            touchSession(sessionKey, now)
            void handleToolUpdate(part, session.channel, session.thread)
            break
          }
        }
      }
    }
  }
}

const MAX_RETRIES = 5
const RETRY_DELAYS = [1_000, 2_000, 4_000, 8_000, 16_000]

void (async () => {
  for (let attempt = 0; ; attempt++) {
    try {
      await subscribeLoop()
    } catch (error) {
      console.error(`Subscribe error (attempt ${attempt + 1}):`, error)
    }
    if (attempt >= MAX_RETRIES) {
      console.error(`Subscribe loop abandoned after ${MAX_RETRIES} retries`)
      break
    }
    const delay = RETRY_DELAYS[attempt] ?? 16_000
    await new Promise((resolve) => setTimeout(resolve, delay))
  }
})()

async function handleToolUpdate(part: ToolPart, channel: string, thread: string) {
  if (part.state.status !== "completed") return
  const toolMessage = `*${part.tool}* - ${part.state.title}`
  await app.client.chat
    .postMessage({
      channel,
      thread_ts: thread,
      text: toolMessage,
    })
    .catch(() => {})
}

app.use(async ({ next, context }) => {
  console.log("📡 Raw Slack event:", JSON.stringify(context, null, 2))
  await next()
})

app.message(async ({ message, say }) => {
  console.log("📨 Received message event:", JSON.stringify(message, null, 2))

  if (message.subtype || !("text" in message) || !message.text) {
    console.log("⏭️ Skipping message - no text or has subtype")
    return
  }

  console.log("✅ Processing message:", message.text)

  const channel = message.channel
  const thread = (message as any).thread_ts || message.ts
  const sessionKey = `${channel}-${thread}`
  const now = Date.now()
  pruneSessions(now)

  let session = sessions.get(sessionKey)
  if (session) touchSession(sessionKey, now)

  if (!session) {
    console.log("🆕 Creating new opencode session...")
    const { client, server } = opencode

    const createResult = await client.session.create({
      body: { title: `Slack thread ${thread}` },
    })

    if (createResult.error) {
      console.error("❌ Failed to create session:", createResult.error)
      await say({
        text: "Sorry, I had trouble creating a session. Please try again.",
        thread_ts: thread,
      })
      return
    }

    console.log("✅ Created opencode session:", createResult.data.id)

    session = { client, server, sessionId: createResult.data.id, channel, thread, lastSeenAt: now }
    sessions.set(sessionKey, session)
    pruneSessions(now)

    const shareResult = await client.session.share({ path: { id: createResult.data.id } })
    if (!shareResult.error && shareResult.data) {
      const sessionUrl = shareResult.data.share?.url
      console.log("🔗 Session shared:", sessionUrl)
      await app.client.chat.postMessage({ channel, thread_ts: thread, text: sessionUrl })
    }
  }

  console.log("📝 Sending to opencode:", message.text)
  const result = await session.client.session.prompt({
    path: { id: session.sessionId },
    body: { parts: [{ type: "text", text: message.text }] },
  })

  console.log("📤 Opencode response:", JSON.stringify(result, null, 2))

  if (result.error) {
    console.error("❌ Failed to send message:", result.error)
    await say({
      text: "Sorry, I had trouble processing your message. Please try again.",
      thread_ts: thread,
    })
    return
  }

  const response = result.data

  // Build response text
  // AssistantMessage carries no text of its own; the reply text lives in the text parts.
  const responseText =
    response.parts
      ?.filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("\n") || "I received your message but didn't have a response."

  console.log("💬 Sending response:", responseText)

  // Send main response (tool updates will come via live events)
  await say({ text: responseText, thread_ts: thread })
})

app.command("/test", async ({ command, ack, say }) => {
  await ack()
  console.log("🧪 Test command received:", JSON.stringify(command, null, 2))
  await say("🤖 Bot is working! I can hear you loud and clear.")
})

await app.start()
console.log("⚡️ Slack bot is running!")

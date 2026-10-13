import z from "zod"
import { SessionID } from "@opencode-ai/core/session/schema"

export const TeamID = z.string().brand("TeamID")
export type TeamID = z.infer<typeof TeamID>

export const TeamMessage = z.object({
  id: z.string(),
  from: z.string(),
  fromAgent: z.string(),
  to: z.string().optional(),
  content: z.string(),
  timestamp: z.number(),
})
export type TeamMessage = z.infer<typeof TeamMessage>

export const TeamMember = z.object({
  sessionID: SessionID.zod,
  agent: z.string(),
  role: z.string(),
  joinedAt: z.number(),
})
export type TeamMember = z.infer<typeof TeamMember>

export const TeamInfo = z.object({
  id: TeamID,
  members: z.array(TeamMember),
  createdAt: z.number(),
  directory: z.string(),
})
export type TeamInfo = z.infer<typeof TeamInfo>

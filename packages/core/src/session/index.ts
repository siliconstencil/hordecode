export * as Session from "./session"
// SessionV2 (fork-native) re-exported for existing consumers (server/*,
// opencode/session/*) that predate the V2 Session port. A package.json change
// pointed "./session" at this barrel exclusively, silently dropping SessionV2
// from resolution.
export * as SessionV2 from "../session"

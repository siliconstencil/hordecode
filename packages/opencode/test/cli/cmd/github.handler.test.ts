import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import type {
  IssueCommentEvent,
  IssuesEvent,
  PullRequestReviewCommentEvent,
  WorkflowDispatchEvent,
  WorkflowRunEvent,
  PullRequestEvent,
} from "@octokit/webhooks-types"
import {
  normalizeModel,
  normalizeRunId,
  normalizeShare,
  normalizeUseGithubToken,
  normalizeOidcBaseUrl,
  isIssueCommentEvent,
} from "../../../src/cli/cmd/github.handler"

type AnyEvent =
  | IssueCommentEvent
  | IssuesEvent
  | PullRequestReviewCommentEvent
  | WorkflowDispatchEvent
  | WorkflowRunEvent
  | PullRequestEvent

const ENV_KEYS = ["MODEL", "GITHUB_RUN_ID", "SHARE", "USE_GITHUB_TOKEN", "OIDC_BASE_URL"] as const

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k]
})
afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k]
})

describe("normalizeModel", () => {
  it("throws when MODEL unset", () => {
    expect(() => normalizeModel()).toThrow('Environment variable "MODEL" is not set')
  })
  it("returns provider/model when set", () => {
    process.env["MODEL"] = "anthropic/claude"
    const result = normalizeModel()
    expect(result.providerID as string).toBe("anthropic")
    expect(result.modelID as string).toBe("claude")
  })
  it("throws on invalid model format", () => {
    process.env["MODEL"] = "badmodel"
    expect(() => normalizeModel()).toThrow(/Invalid model/)
  })
})

describe("normalizeRunId", () => {
  it("throws when GITHUB_RUN_ID unset", () => {
    expect(() => normalizeRunId()).toThrow('Environment variable "GITHUB_RUN_ID" is not set')
  })
  it("returns GITHUB_RUN_ID when set", () => {
    process.env["GITHUB_RUN_ID"] = "12345"
    expect(normalizeRunId()).toBe("12345")
  })
})

describe("normalizeShare", () => {
  it("returns undefined when SHARE unset", () => {
    expect(normalizeShare()).toBeUndefined()
  })
  it("parses true/false", () => {
    process.env["SHARE"] = "true"
    expect(normalizeShare()).toBe(true)
    process.env["SHARE"] = "false"
    expect(normalizeShare()).toBe(false)
  })
  it("throws on invalid SHARE", () => {
    process.env["SHARE"] = "maybe"
    expect(() => normalizeShare()).toThrow(/Invalid share value/)
  })
})

describe("normalizeUseGithubToken", () => {
  it("defaults false when unset", () => {
    expect(normalizeUseGithubToken()).toBe(false)
  })
  it("parses true/false", () => {
    process.env["USE_GITHUB_TOKEN"] = "true"
    expect(normalizeUseGithubToken()).toBe(true)
    process.env["USE_GITHUB_TOKEN"] = "false"
    expect(normalizeUseGithubToken()).toBe(false)
  })
  it("throws on invalid value", () => {
    process.env["USE_GITHUB_TOKEN"] = "yes"
    expect(() => normalizeUseGithubToken()).toThrow(/Invalid use_github_token/)
  })
})

describe("normalizeOidcBaseUrl", () => {
  it("defaults to opencode api", () => {
    expect(normalizeOidcBaseUrl()).toBe("https://api.opencode.ai")
  })
  it("strips trailing slashes", () => {
    process.env["OIDC_BASE_URL"] = "https://oidc.example.com/"
    expect(normalizeOidcBaseUrl()).toBe("https://oidc.example.com")
    process.env["OIDC_BASE_URL"] = "https://oidc.example.com///"
    expect(normalizeOidcBaseUrl()).toBe("https://oidc.example.com")
  })
})

describe("isIssueCommentEvent", () => {
  it("true for issue comment event", () => {
    expect(isIssueCommentEvent({ issue: {}, comment: {} } as unknown as AnyEvent)).toBe(true)
  })
  it("false when no comment", () => {
    expect(isIssueCommentEvent({ issue: {} } as unknown as AnyEvent)).toBe(false)
  })
  it("false for unrelated event", () => {
    expect(isIssueCommentEvent({ foo: 1 } as unknown as AnyEvent)).toBe(false)
  })
})

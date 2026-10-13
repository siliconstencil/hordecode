import { describe, it, expect } from "bun:test"

describe("CronTool shell mode", () => {
  it("accepts shell property in schedule operation", () => {
    const input = {
      operation: {
        action: "schedule" as const,
        cron: "0 9 * * *",
        prompt: "test prompt",
        shell: "echo hello",
      },
    }
    expect(input.operation.shell).toBe("echo hello")
  })

  it("accepts shell property in loop operation", () => {
    const input = {
      operation: {
        action: "loop" as const,
        delay_seconds: 300,
        prompt: "test loop",
        shell: "df -h",
      },
    }
    expect(input.operation.shell).toBe("df -h")
  })

  it("schedule operation without shell defaults to undefined", () => {
    const input = {
      operation: {
        action: "schedule" as const,
        cron: "0 9 * * *",
        prompt: "test prompt",
      },
    }
    expect("shell" in input.operation).toBe(false)
  })

  it("loop operation without shell defaults to undefined", () => {
    const input = {
      operation: {
        action: "loop" as const,
        delay_seconds: 300,
        prompt: "test loop",
      },
    }
    expect("shell" in input.operation).toBe(false)
  })

  it("accepts name property in schedule operation", () => {
    const input = {
      operation: {
        action: "schedule" as const,
        cron: "0 9 * * *",
        prompt: "test prompt",
        name: "Daily digest",
      },
    }
    expect(input.operation.name).toBe("Daily digest")
  })

  it("accepts name property in loop operation", () => {
    const input = {
      operation: {
        action: "loop" as const,
        delay_seconds: 300,
        prompt: "test loop",
        name: "Heartbeat",
      },
    }
    expect(input.operation.name).toBe("Heartbeat")
  })

  it("schedule operation without name defaults to undefined", () => {
    const input = {
      operation: {
        action: "schedule" as const,
        cron: "0 9 * * *",
        prompt: "test prompt",
      },
    }
    expect("name" in input.operation).toBe(false)
  })

  it("accepts timezone property in schedule operation", () => {
    const input = {
      operation: {
        action: "schedule" as const,
        cron: "30 9 * * *",
        prompt: "morning standup",
        timezone: "Europe/Istanbul",
      },
    }
    expect(input.operation.timezone).toBe("Europe/Istanbul")
  })

  it("schedule operation without timezone defaults to undefined", () => {
    const input = {
      operation: {
        action: "schedule" as const,
        cron: "0 9 * * *",
        prompt: "test prompt",
      },
    }
    expect("timezone" in input.operation).toBe(false)
  })

  it("get operation accepts name lookup instead of id", () => {
    const input = {
      operation: {
        action: "get" as const,
        name: "Daily digest",
      },
    }
    expect(input.operation.name).toBe("Daily digest")
    expect("id" in input.operation).toBe(false)
  })

  it("delete operation accepts name lookup instead of id", () => {
    const input = {
      operation: {
        action: "delete" as const,
        name: "Daily digest",
      },
    }
    expect(input.operation.name).toBe("Daily digest")
    expect("id" in input.operation).toBe(false)
  })

  it("rename operation accepts name lookup instead of id", () => {
    const input = {
      operation: {
        action: "rename" as const,
        name: "Daily digest",
        prompt: "new prompt body",
      },
    }
    expect(input.operation.name).toBe("Daily digest")
    expect("id" in input.operation).toBe(false)
  })
})

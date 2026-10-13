import path from "path";
import { pathToFileURL } from "url";
import { Effect } from "effect";
import { Ripgrep } from "@opencode-ai/core/ripgrep";
import { Flag } from "@opencode-ai/core/flag/flag";
import type { Info } from "@/skill";

export const renderSkillContent = Effect.fn("SkillContent.render")(function* (
  info: Info,
  rg: Ripgrep.Interface,
  signal: AbortSignal,
) {
  const dir = path.dirname(info.location);
  const entries = yield* rg.find({
    cwd: dir,
    pattern: "*",
    hidden: true,
    follow: false,
    signal,
    limit: Flag.HORDECODE_SKILL_SEARCH_FILE_SAMPLE_LIMIT,
  });
  const files = entries
    .filter((entry) => !entry.path.endsWith("SKILL.md"))
    .map((entry) => `<file>${path.resolve(dir, entry.path)}</file>`)
    .join("\n");
  return {
    dir,
    output: [
      `<skill_content name="${info.name}">`,
      `# Skill: ${info.name}`,
      "",
      info.content.trim(),
      "",
      `Base directory for this skill: ${pathToFileURL(dir).href}`,
      "Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.",
      "Note: file list is sampled.",
      "",
      "<skill_files>",
      files,
      "</skill_files>",
      "</skill_content>",
    ].join("\n"),
  };
});

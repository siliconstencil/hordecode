import { Effect, Schema } from "effect";
import { Ripgrep } from "@opencode-ai/core/ripgrep";
import { Flag } from "@opencode-ai/core/flag/flag";
import { Agent } from "@/agent/agent";
import { Skill } from "@/skill";
import { searchSkills } from "@/skill/search";
import { renderSkillContent } from "./skill-content";
import * as Tool from "./tool";

const Parameters = Schema.Struct({
  query: Schema.String,
});

type Metadata = { status: "no_match" | "matched"; loadedSkillID: string | null };

export const SkillSearchTool = Tool.define<typeof Parameters, Metadata, Skill.Service | Ripgrep.Service | Agent.Service>(
  "skill_search",
  Effect.gen(function* () {
    const skill = yield* Skill.Service;
    const rg = yield* Ripgrep.Service;
    const agents = yield* Agent.Service;
    return {
      description: [
        "Search the available non-Harness skills using exact ID/name/alias matching and BM25 relevance.",
        "On the user's first query, call this tool when the task might benefit from a specialized workflow.",
        "Include: action, input, desired output, and audience. Omit dimensions the user did not provide.",
        "An exact high-confidence match is loaded automatically; uncertain matches are returned for you to assess.",
      ].join("\n"),
      parameters: Parameters,
      execute: (params: { query: string }, ctx: Tool.Context): Effect.Effect<Tool.ExecuteResult<Metadata>> =>
        Effect.gen(function* () {
          const agent = yield* agents.get(ctx.agent);
          const available = yield* skill.available(agent);
          const results = searchSkills(params.query, available);
          if (results.length === 0) {
            return {
              title: "No matching skill",
              output: JSON.stringify(
                { status: "no_match", results: [], loaded_skill_id: null },
                null,
                2,
              ),
              metadata: { status: "no_match", loadedSkillID: null } as const,
            };
          }
          const loaded =
            results[0].score >= Flag.HORDECODE_SKILL_SEARCH_AUTO_LOAD_THRESHOLD
              ? available.find((item) => item.name === results[0].skill_id)
              : undefined;
          const payload = {
            status: "matched",
            results,
            loaded_skill_id: loaded?.name ?? null,
          };
          if (!loaded) {
            return {
              title: `Found ${results.length} skill${results.length === 1 ? "" : "s"}`,
              output: JSON.stringify(payload, null, 2),
              metadata: { status: "matched", loadedSkillID: null } as const,
            };
          }
          yield* ctx.ask({
            permission: "skill",
            patterns: [loaded.name],
            always: [loaded.name],
            metadata: {},
          });
          const rendered = yield* renderSkillContent(loaded, rg, ctx.abort);
          return {
            title: `Loaded skill: ${loaded.name}`,
            output: [JSON.stringify(payload, null, 2), "", rendered.output].join("\n"),
            metadata: { status: "matched", loadedSkillID: loaded.name } as const,
          };
        }).pipe(Effect.orDie),
    };
  }),
);

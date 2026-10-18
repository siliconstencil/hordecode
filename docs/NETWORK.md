# Network access

Every outbound connection Hordecode makes, what starts it, and how to turn it off. Hordecode
has no product telemetry, analytics or crash reporting.

Environment switches accept the `HORDECODE_` name and the `OPENCODE_` name; the `HORDECODE_`
value wins when both are set.

## On by default

| Host | When | What is sent | Control |
| --- | --- | --- | --- |
| `models.opencode.ai` | Model catalog: at startup when the cached copy is older than 5 minutes, then hourly | A plain GET with a `User-Agent` | `HORDECODE_DISABLE_MODELS_FETCH=1`; `HORDECODE_MODELS_URL` picks another catalog, `HORDECODE_MODELS_PATH` a local file |
| `models.dev` | Legacy catalog loader, on first use only | A plain GET | `HORDECODE_DISABLE_MODELS_FETCH=1` |
| `api.github.com` (Hordecode releases); npm registry for npm, bun and pnpm installs | Update check | A plain GET | `HORDECODE_DISABLE_AUTOUPDATE=1`. A check never installs: a newer version shows a notice and installs when you confirm or run `horde upgrade` |
| `github.com/tree-sitter/...`, `raw.githubusercontent.com/...` | The terminal UI renders a code block in a language whose grammar is not cached yet | A plain GET for the grammar file | Cached after the first download |
| `github.com/BurntSushi/ripgrep/releases` | First search when `rg` is neither on `PATH` nor already downloaded | A plain GET | Put `rg` on `PATH` |

## When you configure or call it

| Host | When | What is sent |
| --- | --- | --- |
| Your model providers | Each agent turn with that provider's model | The conversation, tool results and your key, as for any API client. The default `User-Agent` is `hordecode/<version>`; some providers also receive attribution headers naming Hordecode |
| ChatGPT sign-in (`auth.openai.com`, `chatgpt.com`), GitHub Copilot (`github.com`, `api.githubcopilot.com`) | After you sign in with that provider | The sign-in flow, then model requests |
| opencode Zen and opencode Go (`opencode.ai`) | When you use those providers with your API key | Model requests |
| Any URL the model fetches (`webfetch`) | A tool call; the build agent asks before each fetch by default | The request for that URL |
| `mcp.exa.ai`, `search.parallel.ai` | The `websearch` tool, with `HORDECODE_ENABLE_EXA=1` or `HORDECODE_ENABLE_PARALLEL=1` | The search query |
| `huggingface.co` | First semantic memory search with `memory.embedding` enabled | The embedding model download, about 133 MB, once |
| npm registry | Plugins listed in `plugin`; provider SDK packages for the providers you use | Package downloads |
| npm registry, GitHub releases | Language servers (`lsp`) and formatters (`formatter`) you enable, installed on first use | Package and archive downloads; `HORDECODE_DISABLE_LSP_DOWNLOAD=1` stops language server downloads |
| URLs in `instructions`, `skills.urls` and remote `references` | Loading the config, skills or references you list | Plain GETs |
| Your MCP servers and remote workspaces | When configured | MCP and workspace traffic |
| Your share server (`enterprise.url`) | `/share` or `share: "auto"` with a configured share server | The shared session |
| Your GitHub token broker (`OIDC_BASE_URL`) | `horde github run` in GitHub Actions, when configured | The Actions OIDC token |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | When you set it | Logs and traces |

## Install script

`https://hordecode.com/install` redirects to the `install` script in this repository. The
script downloads the release archive and its `SHA256SUMS` from GitHub releases and checks the
archive before extracting it. `HORDECODE_RELEASE_BASE` points it at a mirror.

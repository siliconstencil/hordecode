# Security

## IMPORTANT

We do not accept AI generated security reports. We receive a large number of
these and we absolutely do not have the resources to review them all. If you
submit one that will be an automatic ban from the project.

## Threat Model

### Overview

Hordecode is an AI-powered coding assistant that runs locally on your machine. It provides an agent system with access to powerful tools including shell execution, file operations, and web access.

### No Sandbox

Hordecode does **not** sandbox the agent. The permission system exists as a UX feature to help users stay aware of what actions the agent is taking - it prompts for confirmation before executing commands, writing files, etc. However, it is not designed to provide security isolation.

If you need true isolation, run Hordecode inside a Docker container or VM.

### Server Mode

Server mode is opt-in only. When enabled, set `HORDECODE_SERVER_PASSWORD` to require HTTP Basic Auth. `OPENCODE_SERVER_PASSWORD` is also accepted for compatibility. Without this, the server runs unauthenticated (with a warning). It is the end user's responsibility to secure the server - any functionality it provides is not a vulnerability.

### Out of Scope

| Category                        | Rationale                                                               |
| ------------------------------- | ----------------------------------------------------------------------- |
| **Server access when opted-in** | If you enable server mode, API access is expected behavior              |
| **Sandbox escapes**             | The permission system is not a sandbox (see above)                      |
| **LLM provider data handling**  | Data sent to your configured LLM provider is governed by their policies |
| **MCP server behavior**         | External MCP servers you configure are outside our trust boundary       |
| **Malicious config files**      | Users control their own config; modifying it is not an attack vector    |

---

## Data Retention and PII

Hordecode stores session history, tool outputs, task state, and inbox rows in local SQLite files at `~/.local/share/hordecode/hordecode.db`. These files may contain prompts, file excerpts, and other user-controlled content (PII). Treat them as sensitive user data.

- **Filesystem permissions**: Hordecode sets mode 0600 on the database file when it opens it, restricting access to the owner only. On shared machines, verify with:
  ```bash
  ls -l ~/.local/share/hordecode/hordecode.db
  ```
  The permissions should show `-rw-------` (0600).

- **Retention**:
  - Tasks: Tasks marked done or abandoned are hidden from default task lists after 7 days (configurable via `task_archive_days`). The rows are kept, not deleted.
  - Inbox: Inbox rows older than 7 days are garbage-collected on startup.
  - Session context: Compaction and context pruning are in-memory and do not delete session history.

- **Deletion**: Durable deletion of user data is never automatic. Retention cleanup only filters or garbage-collects the rows named above.

# Reporting Security Issues

We appreciate your efforts to responsibly disclose your findings, and will make every effort to acknowledge your contributions.

To report a security issue, please use the GitHub Security Advisory ["Report a Vulnerability"](https://github.com/siliconstencil/hordecode/security/advisories/new) tab.

The team will send a response indicating the next steps in handling your report. After the initial reply to your report, the security team will keep you informed of the progress towards a fix and full announcement, and may ask for additional information or guidance.

## Escalation

If you do not receive an acknowledgement of your report within 6 business days, please open a follow-up via the same advisory workflow or a private security issue. Hordecode is an independent fork; do not report Hordecode issues to the opencode maintainers.

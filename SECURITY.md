# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Report privately through GitHub's [private vulnerability reporting](https://github.com/Andyyao12/Bilibili-AI-Playlist-Agent/security/advisories/new)
(Security → Advisories → Report a vulnerability). If that is unavailable, contact the maintainer through the
email on the GitHub profile.

Please include: affected version or commit, a description of the issue, reproduction steps, and the impact you
believe it has. You will get an acknowledgement as soon as possible; fixes are prioritised over new features.

## Supported versions

The project is at `0.1.x`. Only the latest `main` and the most recent release receive fixes.

## Threat model

Understanding what this extension does and does not do makes reviewing it much faster.

**It has no backend, no account system and no telemetry.** It communicates with exactly two parties:

1. The Bilibili website, loaded in your own browser tab, driven through normal page interaction.
2. The model endpoint **you** configure, called from the extension's service worker.

**Credentials**

- The API key is stored in `chrome.storage.local`, which is scoped to the browser profile and not synced.
- The key is sent only to the base URL you entered, as an `Authorization: Bearer …` header.
- The key is **never** written to logs. `src/utils/logger.ts` redacts registered secrets plus `Bearer …`,
  `sk-…` and `api_key` patterns on every entry, and request logging records only the endpoint with its query
  string stripped, the model name, error codes and timings.
- No key is bundled with the extension or required to build it.

**Permissions and their purpose**

| Permission | Why it is needed |
| --- | --- |
| `storage` | Save LLM settings (local) and the agent snapshot (session) |
| `tabs` | Navigate the tab the agent controls to Bilibili search and video pages |
| `sidePanel` | Host the UI |
| `scripting` | Content script injection |
| `alarms` | Timeout safety net while waiting for external events |
| `<all_urls>` | The model base URL is supplied by the user at runtime, so a concrete origin cannot be declared in advance |

The content script is registered only for `www.bilibili.com` and `search.bilibili.com`, and it acts only after a
handshake confirms the tab is the one the agent is driving. Pages unrelated to the agent's controlled tab
receive `role: none` and the content script exits immediately.

## Explicit non-goals / accepted risks

- **A compromised model endpoint is trusted by design.** The extension sends your prompts and the candidate
  titles to whatever base URL you configure. Only configure endpoints you trust — this is the same trust decision
  as using any AI client.
- **Rendered model output is treated as text.** Model responses are parsed as JSON and used only to select
  candidate indices; URLs always come from DOM extraction. A hostile model cannot inject a video URL into the
  queue, but it *can* choose poor candidates.
- **The Bilibili website is untrusted input.** Extracted titles are inserted into the side panel as React text
  nodes, never as HTML, so page content cannot execute script in the extension's context.
- **No protection against a compromised browser profile or a malicious extension.** Out of scope.

## Please do not

- Open public issues that contain a real API key, a token, or a full request/response dump with credentials.
- Report dependency vulnerabilities that have no exploitable path in this extension without explaining the path.

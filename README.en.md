# drivelift

Lift local files into Google Drive as native Sheets / Docs / Slides. An MCP server and CLI for LLM agents (Claude Code, Cursor, Codex, ...) that turns an xlsx or md on disk into a Drive URL with formatting intact.

[日本語](README.md)

## The problem

Agents write their output to local files, and you want those in Drive. Existing Drive connectors cannot take a local file; pushing the bytes through the conversation as base64 corrupts even tens of kilobytes.

drivelift runs on your machine and takes a file path. Bytes go straight to the Drive API. Conversion to Google Sheets is done by Drive's own import, so formatting such as column widths, fills, tabs and embedded images survives to the extent that import preserves it (the same path as rclone's `--drive-import-formats`).

## Design commitments

- **No shared OAuth client.** You create your own in Google Cloud Console (about five minutes). When nothing is configured, the tools return the Console URLs step by step
- **`drive.file` scope only.** drivelift sees nothing but the files it created. There is no path to damage existing shared documents
- **Secrets never enter the conversation.** The client JSON is imported by file path only
- **No hosting.** Sign-in uses a loopback redirect on 127.0.0.1; tokens stay on your machine
- Two dependencies: the MCP SDK and zod. The Drive API is called with plain `fetch`

## Install

Claude Code, in your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "drivelift": {
      "command": "npx",
      "args": ["-y", "drivelift@0"]
    }
  }
}
```

Or `claude mcp add drivelift -- npx -y drivelift@0`. As a CLI: `npx drivelift doctor`.

Requires Node.js 22.13 or later.

## First-time setup

Ask your agent to call `status`; it returns exactly these steps.

1. Create (or pick) a Google Cloud project: https://console.cloud.google.com/projectcreate . If gcloud is installed, the `gcloud_setup` tool (CLI: `drivelift setup-gcloud --yes`) does steps 1-2 for you, showing the commands and asking for approval first. Steps 3-4 have no gcloud equivalent
2. Enable the Google Drive API: https://console.cloud.google.com/apis/library/drive.googleapis.com
3. Configure the OAuth consent screen: https://console.cloud.google.com/auth/overview
   - Google Workspace account: choose **Internal** (no review, tokens do not expire)
   - Personal Gmail: choose **External** and **publish to Production**. In Testing status refresh tokens expire after 7 days
4. Create an OAuth client of type **Desktop app** and download its JSON: https://console.cloud.google.com/auth/clients/create
5. Put the JSON in place. When `status` finds a candidate in `~/Downloads` it returns a ready-made `mv … && chmod 600 …` command; run that. `import_client_secret` (CLI: `drivelift import-secret <path>`) does the same. Without a path it only lists candidates and copies nothing
6. Call `auth_start` (CLI: `drivelift login`) and finish the sign-in in the browser. The tool waits for the consent to complete, so there is no need to tell the agent afterwards

From then on, just call `upload`. Calling `upload` while something is missing returns the same steps as `next_steps`.

## Tools

| Tool | Purpose |
|--|--|
| `status` | Setup state (`no_client` / `no_token` / `token_invalid` / `api_disabled` / `ready`), next steps, Console URLs |
| `auth_start` | Start sign-in: opens the browser and waits up to `wait_seconds` (default 90) for consent; returns `completed`, or `pending` if time runs out |
| `auth_status` | Sign-in progress (`idle` / `pending` / `completed` / `failed`); `wait_seconds` blocks until it settles |
| `import_client_secret` | Copy a downloaded client JSON into the config directory |
| `gcloud_setup` | If gcloud is installed, do steps 1-2 (project and Drive API) on your behalf. Without `confirm` it only returns the commands it would run; `confirm: true` executes them, including `gcloud auth login` (opens a browser) when gcloud has no active account |
| `upload` | Put a file in Drive and return its URL |

`upload` arguments:

| Argument | Meaning |
|--|--|
| `path` | Local file path |
| `name` | Name in Drive. Default: the file name (extension dropped when converting) |
| `folder_id` | Destination folder ID (after `/folders/` in the folder URL). Default: My Drive root. See Limitations |
| `folder_path` | A folder path such as `Reports/2026-09`, found or created under `folder_id` (or My Drive root). Only folders drivelift created are reused |
| `convert` | `auto` (default) / `none` / `spreadsheet` / `document` / `presentation` |
| `share` | Permissions to add to the uploaded file. Each item has `role` (`reader` / `commenter` / `writer`), `type` (`user` / `group` / `domain` / `anyone`) and `target` (email for user/group, domain name for domain, none for anyone) |
| `notify` | Send Google's notification email for user/group shares. Default: no |

Sharing is meant to be set only when the user asks for it, and the tool description says so. `anyone` means anyone with the link, i.e. public; use it only when the user explicitly asks. A failed share does not undo the upload; each share's result comes back in `shared`.

`auto` targets: xlsx, xls, csv, tsv, ods → Sheets; docx, doc, odt, rtf, txt, md, html → Docs; pptx, ppt, odp → Slides. Anything else is stored as-is.

## CLI

```
drivelift                       run as MCP stdio server
drivelift doctor                setup state and next steps
drivelift login                 sign in (waits for completion)
drivelift import-secret [path]  import the client JSON
drivelift setup-gcloud [--project ID] [--yes]  steps 1-2 via gcloud (plan only without --yes)
drivelift upload <file> [--folder ID] [--folder-path A/B] [--name N] [--convert MODE]
                 [--share ROLE:TYPE[:TARGET]]... [--notify] [--json]
```

`upload` prints only the URL by default, so scripts can capture it. `--share` is repeatable (e.g. `--share reader:domain:example.com --share writer:user:alice@example.com`). If any share fails, the URL is still printed and the exit code is 3.

## Configuration

| Where | What |
|--|--|
| `~/.config/drivelift/client_secret.json` | The JSON downloaded from the Console (0600 when imported via `import-secret`; tighten it yourself if you copy it by hand) |
| `~/.config/drivelift/token.json` | Refresh token and cached access token (0600, plaintext) |
| `DRIVELIFT_CONFIG_DIR` | Override the config directory |
| `DRIVELIFT_CLIENT_ID` / `DRIVELIFT_CLIENT_SECRET` | Provide the client via environment instead of the file (for `.mcp.json` `env`) |

## Using it as a team

One person can create the OAuth client and hand the downloaded JSON to the team.

- **Only the JSON is shared.** Each member imports it (`import_client_secret` or `mv`) and signs in with `auth_start` **as themselves**. Tokens stay on each machine; nobody acts with the representative's permissions
- **On Google Workspace, make the consent screen Internal.** Accounts outside the organization cannot authorize, so a leaked JSON is useless outside it. Google does not treat a Desktop client secret as confidential, but still hand it out through a password manager or DM, not a repository
- **Files land in each member's My Drive.** Grant access with `share` (e.g. read access for everyone in the organization: `{"role": "reader", "type": "domain", "target": "example.com"}`)
- **Everyone writing into one shared folder is likely not possible with the current scope.** `drive.file` access is per user, so a folder created by A's drivelift is expected to be invisible to B's drivelift even when shared (not verified yet). For now, create files in each My Drive and deliver them with `share`, or post the URLs somewhere shared
- **Recreating the client makes everyone hit `invalid_client`.** Hand out the new JSON; importing it discards the old token and leads to a fresh sign-in
- **Give the project at least two Owners**, so the client stays manageable when the representative leaves
- **Drive API quota is per project and shared by everyone.** Normal use does not come close

## Limitations

- With the `drive.file` scope, folders that drivelift did not create are invisible to it, so a `folder_id` pointing at an existing folder is expected to be rejected with 404 (being verified on a real account; results go to docs/design.md). For now, omit `folder_id`, let the file land in My Drive root, and move it in the Drive UI. A folder-creation tool or an opt-in `drive` scope will be decided after that check
- Existing files with the same name are not overwritten; a new file is created (Drive's default)
- `token.json` is not encrypted. On shared machines point `DRIVELIFT_CONFIG_DIR` at a protected location
- If a Google Workspace admin restricts third-party API access, even an Internal client may be blocked from authorizing

## Development

```
npm install
npm test
npm run build
```

Tests never reach Google: `fetch` is injected, and the loopback sign-in is exercised on a real local port.

## License

MIT

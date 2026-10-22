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

1. Create (or pick) a Google Cloud project: https://console.cloud.google.com/projectcreate . If gcloud is installed, the `gcloud_setup` tool does steps 1-2 for you: it shows the commands first and runs them after approval. On the CLI, `drivelift setup-gcloud` shows the plan and `--yes` runs it. Steps 3-4 have no gcloud equivalent
2. Enable the Google Drive API: https://console.cloud.google.com/apis/library/drive.googleapis.com
3. Configure the OAuth consent screen: https://console.cloud.google.com/auth/overview
   - Google Workspace account: choose **Internal** (no review, and no 7-day expiry of the Testing status)
   - Personal Gmail: choose **External** and **publish to Production**. In Testing status refresh tokens expire after 7 days
4. Create an OAuth client of type **Desktop app** and download its JSON: https://console.cloud.google.com/auth/clients/create
5. Import the JSON with `import_client_secret` (CLI: `drivelift import-secret <path>`). It validates the file and saves it to the config directory with mode 0600. Without a path it only lists the candidates in `~/Downloads`, newest first, and copies nothing (`status` / `doctor` also list them in `candidates`). Importing copies the file, so the original stays in `~/Downloads`; delete it yourself if you no longer need it
6. Call `auth_start` (CLI: `drivelift login`) and finish the sign-in in the browser. The tool waits for the consent to complete, so there is no need to tell the agent afterwards. To use several Google accounts, see [Multiple Google accounts](#multiple-google-accounts)

From then on, just call `upload`. Calling `upload` while something is missing returns the same steps as `next_steps`.

## Tools

| Tool | Purpose |
|--|--|
| `status` | Setup state (`no_client` / `no_token` / `token_invalid` / `api_disabled` / `ready`, or `account_unresolved` when several accounts are signed in and none applies), next steps, Console URLs. Also returns each signed-in account's state (`accounts`) and the account resolved from the working directory (`resolved`) |
| `auth_start` | Start sign-in: opens the browser and waits up to `wait_seconds` (default 45) for consent; returns `completed`, or `pending` if time runs out. `login_hint` passes an email address to Google as the account to sign in with |
| `auth_status` | Sign-in progress (`idle` / `pending` / `completed` / `failed`); `wait_seconds` blocks until it settles |
| `import_client_secret` | Copy a downloaded client JSON into the config directory |
| `gcloud_setup` | If gcloud is installed, do steps 1-2 (project and Drive API) on your behalf. Without `confirm` it only returns the commands it would run; `confirm: true` executes them, including `gcloud auth login` (opens a browser) when gcloud has no active account |
| `upload` | Put a file in Drive and return its URL |
| `map_source` | Map a source (a repository's git remote, or the absolute path of a non-git directory) to an account; `remove: true` unmaps. Without `source` it only returns the source of `path` (default: the working directory) and writes nothing |

`upload` arguments:

| Argument | Meaning |
|--|--|
| `path` | Local file path |
| `name` | Name in Drive. Default: the file name (extension dropped when converting) |
| `folder_id` | Destination folder ID (after `/folders/` in the folder URL). Any folder you can edit, shared drives included. Default: My Drive root |
| `folder_path` | A folder path such as `Reports/2026-09`, found or created under `folder_id` (or My Drive root). Only folders drivelift created are reused |
| `convert` | `auto` (default) / `none` / `spreadsheet` / `document` / `presentation` |
| `share` | Permissions to add to the uploaded file. Each item has `role` (`reader` / `commenter` / `writer`), `type` (`user` / `group` / `domain` / `anyone`) and `target` (email for user/group, domain name for domain, none for anyone) |
| `share_new_folder` | Also add the `share` permissions to the `folder_path` leaf folder, only if this upload created it. Reused folders and the `folder_id` folder are never shared. Requires `share` and `folder_path` |
| `notify` | Send Google's notification email for user/group shares. Default: no |
| `replace_id` | Instead of creating a new file, replace the contents of an earlier drivelift upload (by ID). URL and sharing stay the same. Cannot be combined with `folder_id` / `folder_path` |
| `account` | Account to upload with (a signed-in email address). Default: resolved from the source (see [Multiple Google accounts](#multiple-google-accounts)) |

`replace_id` is for re-publishing a revised report. The whole content is replaced, so edits and comments made directly in Sheets are lost (earlier versions stay in Drive's version history), and tab IDs change, so links to a specific tab (`#gid=`) break. To avoid replacing the wrong file, drivelift refuses without sending anything when the target is in the trash, has a different name than this upload would get, or is a different kind (e.g. a Doc for a spreadsheet upload). Under drive.file, files drivelift did not create cannot be replaced.

Sharing is meant to be set only when the user asks for it, and the tool description says so. `anyone` means anyone with the link, i.e. public; use it only when the user explicitly asks. A failed share does not undo the upload; each share's result comes back in `shared`.

`share_new_folder` is for handing a per-PR or per-date folder to your team by URL. Results for the folder come back in `folder_shared` (empty when nothing was shared). Only the leaf folder (`folder_id` in the result) is shared, not intermediate folders created on the way. Folder sharing is inherited, so **anything put in that folder later is visible to the same recipients**. Reused folders are never shared, because that would expose files already in them. As a result, folders created before this option existed, or whose share failed when they were created, stay unshared on later uploads; share them in Drive by hand if needed.

`auto` targets: xlsx, xlsm, xls, ods, csv, tsv → Sheets; docx, doc, odt, rtf, txt, md, html, htm → Docs; pptx, ppt, odp → Slides. Anything else is stored as-is. Conversion is Drive's own import; verified on a real account for xlsx and csv (Sheets) and md (Docs with headings and tables interpreted); the rest follows Drive's supported import formats.

## CLI

```
drivelift                       run as MCP stdio server
drivelift doctor                setup state and next steps, signed-in accounts and the one resolved
drivelift login [--hint EMAIL]  sign in (waits for completion)
drivelift import-secret [path]  import the client JSON
drivelift setup-gcloud [--project ID] [--yes]  steps 1-2 via gcloud (plan only without --yes)
drivelift upload <file> [--account EMAIL] [--folder ID] [--folder-path A/B] [--name N] [--convert MODE]
                 [--share ROLE:TYPE[:TARGET]]... [--share-new-folder] [--notify] [--replace ID] [--json]
drivelift map <email> [source] [--remove]  map a source to an account (without source: only print the working directory's source)
```

`upload` prints only the URL by default, so scripts can capture it. `--share` is repeatable (e.g. `--share reader:domain:example.com --share writer:user:alice@example.com`). If any share fails (including a folder share from `--share-new-folder`), the URL is still printed and the exit code is 3. If `--share-new-folder` finds the folder already existed, a note that it was not shared goes to stderr (exit code 0). When the account cannot be resolved the upload is refused with exit code 2. When you upload with `--account` and the file's git repository is not mapped to any account, the `drivelift map` command to map it goes to stderr (arguments with shell special characters are single-quoted). If the source is mapped to a different account, a note saying so goes to stderr (the file is still uploaded).

## Configuration

| Where | What |
|--|--|
| `~/.config/drivelift/client_secret.json` | The client for the next sign-in: the JSON downloaded from the Console (0600 when imported via `import-secret`; tighten it yourself if you copy it by hand) |
| `~/.config/drivelift/accounts/<email>/client_secret.json` | Copy of the client that account signed in with (0600), used for refresh. Not created when signing in with the environment-variable client; refresh then uses the environment variables too |
| `~/.config/drivelift/accounts/<email>/token.json` | Refresh token and cached access token (0600, plaintext) |
| `~/.config/drivelift/accounts/<email>/sources.json` | Sources mapped to that account |
| `~/.config/drivelift/legacy-migration.json` | Record of copying the 0.4.0 `token.json` (a hash of its content and whether it was copied) |
| `DRIVELIFT_CONFIG_DIR` | Override the config directory |
| `DRIVELIFT_CLIENT_ID` / `DRIVELIFT_CLIENT_SECRET` | Provide the client via environment instead of the file (for `.mcp.json` `env`) |
| `DRIVELIFT_ACCOUNT` | Account for `upload` (for `.mcp.json` `env`) |

Each account's slot is named after the email address that about.get returns at sign-in. If the email address cannot be read (for example the Drive API is not enabled), the sign-in fails and nothing is saved; enable the Drive API and sign in again.

### Moving from 0.4.0

Up to 0.4.0 there was a single slot, `~/.config/drivelift/token.json`. 0.5.0 and later never read that file; the first time you call `status`, `upload` or `map_source` (CLI: `doctor`, `upload`, `map`), it is copied into the slot of its account. Before copying, drivelift refreshes once with the current client to check that the token still works. If it does not, nothing is copied and the reason is returned (`invalid_grant`, `invalid_client`, or a network failure). While no account is signed in, all three tools return that reason. If the file is corrupted, you are asked to sign in again.

The outcome is recorded in `legacy-migration.json` together with a hash of the `token.json` content; as long as the content is unchanged, it is not copied again. When Google rejected it (`invalid_grant`, `invalid_client`), drivelift also stops retrying until the file changes, and `status` keeps showing the reason and how to delete the file. A network failure is not recorded, so the next call retries. If `token.json` changes (for example after signing in again on 0.4.0), it is copied again, except into a slot that already exists for the same account (so a slot you re-signed on 0.5.0 is not reverted to the older token).

The original `token.json` is not deleted, so a running 0.4.0 process or another setup still on 0.4.0 keeps using it. If you only use 0.5.0 or later, you can delete it with `rm ~/.config/drivelift/token.json`; `status` says so too.

Replacing the top-level `client_secret.json` does not remove signed-in accounts; each slot keeps refreshing with its own copy of the client.

## Multiple Google accounts

If you keep a separate Google account per client or project, sign in with each account and map your working repositories (sources) to accounts.

```
drivelift login --hint a@client-a.example
drivelift login --hint me@gmail.com
cd ~/work/client-a-repo && drivelift map a@client-a.example
```

Without a source, `map` only prints the working directory's source (e.g. `github.com/client-a/repo`) and writes nothing. Check it, then map it with `drivelift map a@client-a.example github.com/client-a/repo`. The `map_source` tool does the same.

In a git working tree the source is the normalized URL of remote `origin` (`github.com/org/repo`, ignoring the differences between `https://`, `git@host:`, a port, `.git` and a trailing `/`), so a different clone location or a worktree gives the same source. A git repository without origin is identified by the absolute path of its root, and a non-git directory by its absolute path; a mapped absolute path also covers everything below it.

- **A path mapping does not apply inside a git working tree that has an origin remote**, because the source there is the remote. Map such repositories by remote
- **When path mappings overlap, the longest one wins.** With `/work` mapped to A and `/work/clientB` to B, `/work/clientB/x` goes to B and the rest of `/work` to A
- **The filesystem root (`/`), the home directory, the temp directories (including `/tmp` and `/var/tmp`) and their parents cannot be mapped**, since as a prefix they would match almost every file. For the same reason, when the home directory itself is a git repository (dotfiles and the like), its remote is never offered in `suggest_map`, and `map` reports it as not mappable. When a remote is given as the source, this is refused only if the working directory's git points at that remote (otherwise the size of its working tree cannot be known)
- **Give a git remote with its host** (`github.com/owner/repo`, or a clone URL). A bare `owner/repo` is refused. For a host without a dot (such as an internal git server), give the clone URL (`git@gitserver:org/repo` or `https://gitserver/org/repo`)
- **Remotes are lowercased as a whole. Paths are resolved with realpath to their actual spelling.** Symlinks resolve to their target, and on a case-insensitive filesystem (the macOS default) the spelling on disk is used. A path that does not exist cannot be mapped (it can still be unmapped)
- **If git cannot read the repository, the source is treated as unknown.** For example when git is not installed, or the repository is owned by another user (dubious ownership). drivelift does not fall back to path mappings, and refuses when two or more accounts are signed in. The reason is in `status` → `resolved.reason` and in the refusal

`upload` picks the account in this order:

1. The `account` argument (CLI: `--account`)
2. The `DRIVELIFT_ACCOUNT` environment variable. Put it in the `env` of a project's `.mcp.json` to always use that account from the project
3. The source of the uploaded file, looked up in each account's `sources.json`
4. The only signed-in account, if there is just one
5. Otherwise, with two or more accounts, it **refuses without sending anything**. The response lists the accounts to choose from (`candidates`) and the source (`source`), so the user can decide which account to use

A source mapped to two accounts (for example in a hand-edited `sources.json`) is refused the same way as in 5. In the result, `account` is the account used and `source` is the source used to resolve it (`null` when the argument, the environment variable or the only account decided).

Mappings are never written automatically. When you upload with `account` and the file's git repository is not mapped to any account, the result contains `suggest_map` (`source` and `account`); the agent uses it to offer the mapping to the user. `map_source` is meant to be called only after the user approves, and its tool description says so.

Path sources (non-git directories, or git without origin) never get `suggest_map`. A path mapping covers every file below it, so it is created only when the user asks for it explicitly with `map_source` (`map`), never from an agent's suggestion.

If the `account` you pass differs from the account the source is mapped to, the upload still uses the account you passed, and the result contains `mapped_to` (the mapped account) so the agent can confirm with the user that the intended account was used.

`map_source` refuses a source that is already mapped to another account. To move it, first remove it from that account with `remove: true`, then add it. The two steps keep a single injected call from permanently changing where uploads go.

Signing in again with the same account replaces only that account's slot. The sign-in URL carries `prompt=select_account`, so you always pass through the account chooser (drivelift does not silently reuse the previous account). With `login_hint`, the chooser presents that account (observed 2026-10-16; whether other accounts appear alongside depends on the browser's sessions). To remove an account, delete its slot directory (`~/.config/drivelift/accounts/<email>`). There is no tool for removing accounts.

## Using it as a team

One person can create the OAuth client and hand the downloaded JSON to the team.

- **Only the JSON is shared.** Each member imports it (`import_client_secret` or `mv`) and signs in with `auth_start` **as themselves**. Tokens stay on each machine; nobody acts with the representative's permissions
- **On Google Workspace, make the consent screen Internal.** Accounts outside the organization cannot authorize, so a leaked JSON is useless outside it. Google does not treat a Desktop client secret as confidential, but still hand it out through a password manager or DM, not a repository
- **Files land in each member's My Drive.** Grant access with `share` (e.g. read access for everyone in the organization: `{"role": "reader", "type": "domain", "target": "example.com"}`)
- **A team shared folder (including a shared drive) works.** Pass its ID as `folder_id` and each member's drivelift writes straight into it. Subfolders from `folder_path`, however, are created per member (A's drivelift-made folder is invisible to B's drivelift). To gather everything in one place, create the subfolders by hand and hand out their IDs for `folder_id`
- **To hand out the URL of a folder drivelift created, add `share_new_folder`.** Without it only the file is shared, and only its creator can open the folder
- **Recreating the client makes everyone hit `invalid_client`.** Hand out the new JSON; each member imports it and signs in again with `auth_start`, which replaces the client and token of their slot
- **Give the project at least two Owners**, so the client stays manageable when the representative leaves
- **Drive API quota is per project and shared by everyone.** Normal use does not come close

## Limitations

- **Always-allowing `upload` also always-allows sharing.** With `share`, one call can grant access to any outside address or domain (since 0.2.0). If your host is set to always allow upload, a prompt injection could share files externally. Users who always-allowed it on 0.1.0 get newer versions automatically via `drivelift@0` (0.2.0 and later; since 0.3.0 that includes `replace_id`, since 0.4.0 `share_new_folder`). `upload` is annotated as destructive (`destructiveHint: true`). If that worries you, set upload to ask every time. The same applies to `share_new_folder`: it only touches folders it just created, but the share extends to whatever is put in that folder later

- `folder_id` accepts any folder the signed-in account can edit, including folders drivelift did not create and folders in shared drives (confirmed on a shared drive, 2026-09-25). With `drive.file`, drivelift cannot see those folders' contents, so `folder_path` only reuses folders drivelift created; it makes its own folder even if a same-named one made by someone else exists
- Existing files with the same name are not overwritten; a new file is created (Drive's default). Overwriting happens only with an explicit `replace_id`
- If `upload` is always allowed, a prompt injection could replace a drivelift-made file with other content (`replace_id`, since 0.3.0). It cannot reach files drivelift did not create, and earlier versions can be restored from version history
- **`map_source` and the `account` argument of `upload` let a prompt injection change which account receives uploads.** A mapping applies to every later upload from that source. Moving a mapping takes two calls (remove, then add), but if `map_source` is always allowed both go through without asking. If `upload` is always allowed, the `account` argument can send a file to another account (`mapped_to` in the result shows when it disagrees with the mapping). Set `map_source` to ask every time
- With only one signed-in account, drivelift keeps using it silently, mapped or not, as before. If the only account you signed in with belongs to another client, files go there. Once a second account signs in, uploads from unmapped sources are refused
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

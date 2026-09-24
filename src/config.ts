/**
 * config.ts — 設定ディレクトリと、その中の2ファイル(client_secret.json / token.json)の読み書き。
 *
 * - 置き場所: $DRIVELIFT_CONFIG_DIR、無ければ ~/.config/drivelift
 * - client_secret.json: Google Cloud Console からダウンロードした Desktop 種別クライアントの JSON をそのまま
 * - token.json: refresh_token とキャッシュした access_token
 * - 環境変数 DRIVELIFT_CLIENT_ID / DRIVELIFT_CLIENT_SECRET があればファイルより優先する(.mcp.json の env で渡す用途)
 *
 * secret を会話(LLM のコンテキスト)に通さないため、取り込みはファイルパス経由のみ。
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DriveliftError } from "./errors.js";
import type { ClientSource } from "./status.js";

export interface ClientCredentials {
  clientId: string;
  clientSecret: string;
  source: ClientSource;
}

export interface StoredToken {
  refresh_token: string;
  access_token?: string;
  /** access_token の失効時刻(epoch ms)。 */
  expires_at?: number;
  /** ログイン時に about.get で取れたメールアドレス。表示用で、取れなくても動作に影響しない。 */
  account?: string;
}

export function resolveConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env["DRIVELIFT_CONFIG_DIR"];
  return fromEnv && fromEnv.length > 0 ? fromEnv : join(homedir(), ".config", "drivelift");
}

export function clientSecretPath(configDir: string): string {
  return join(configDir, "client_secret.json");
}

export function tokenPath(configDir: string): string {
  return join(configDir, "token.json");
}

/**
 * Console のダウンロード JSON を検証して client_id / client_secret を取り出す。
 * "web" 種別は固定ポートの redirect_uri 登録が要り、ループバックの動的ポートが使えないので弾く。
 */
export function parseClientSecret(text: string): { clientId: string; clientSecret: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new DriveliftError("client secret file is not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new DriveliftError("client secret JSON must be an object.");
  }
  const record = parsed as Record<string, unknown>;
  if ("web" in record && !("installed" in record)) {
    throw new DriveliftError('This is a "Web application" OAuth client. drivelift needs a "Desktop app" client (loopback redirect with a dynamic port). Create a new client with type Desktop app.');
  }
  const installed = record["installed"];
  if (typeof installed !== "object" || installed === null) {
    throw new DriveliftError('client secret JSON has no "installed" section. Download the JSON of an OAuth client whose type is "Desktop app".');
  }
  const { client_id: clientId, client_secret: clientSecret } = installed as Record<string, unknown>;
  if (typeof clientId !== "string" || clientId.length === 0) {
    throw new DriveliftError('client secret JSON is missing "installed.client_id".');
  }
  if (typeof clientSecret !== "string" || clientSecret.length === 0) {
    throw new DriveliftError('client secret JSON is missing "installed.client_secret".');
  }
  return { clientId, clientSecret };
}

export function loadClientCredentials(configDir: string, env: NodeJS.ProcessEnv = process.env): ClientCredentials | null {
  const envId = env["DRIVELIFT_CLIENT_ID"];
  const envSecret = env["DRIVELIFT_CLIENT_SECRET"];
  if (envId && envSecret) {
    return { clientId: envId, clientSecret: envSecret, source: "env" };
  }
  if (envId || envSecret) {
    throw new DriveliftError("Set both DRIVELIFT_CLIENT_ID and DRIVELIFT_CLIENT_SECRET, or neither (only one of them is set).");
  }
  const path = clientSecretPath(configDir);
  if (!existsSync(path)) return null;
  const { clientId, clientSecret } = parseClientSecret(readFileSync(path, "utf-8"));
  return { clientId, clientSecret, source: "file" };
}

function ensureConfigDir(configDir: string): void {
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
}

/** mode オプションは新規作成時にしか効かないので、既存ファイルにも書き込み後に明示的に 0600 を掛ける。 */
function writePrivate(path: string, text: string): void {
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/**
 * 検証済みの JSON テキストを所定パスへ 0600 で保存し、保存先を返す。
 * client_id が変わる取り込みでは token.json も消す(トークンは発行元クライアントに紐づくので、
 * 残しても refresh が invalid_grant になるだけ。消しておけば次は素直に no_token → auth_start に進む)。
 */
export function saveClientSecret(configDir: string, text: string): { path: string; tokenCleared: boolean } {
  const { clientId } = parseClientSecret(text);
  const existing = existsSync(clientSecretPath(configDir)) ? parseClientSecret(readFileSync(clientSecretPath(configDir), "utf-8")).clientId : null;
  ensureConfigDir(configDir);
  const path = clientSecretPath(configDir);
  writePrivate(path, text);
  const tokenCleared = existing !== null && existing !== clientId && existsSync(tokenPath(configDir));
  if (tokenCleared) deleteToken(configDir);
  return { path, tokenCleared };
}

export function loadToken(configDir: string): StoredToken | null {
  const path = tokenPath(configDir);
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    throw new DriveliftError(`${path} is corrupted. Delete it and sign in again.`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new DriveliftError(`${path} is corrupted. Delete it and sign in again.`);
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record["refresh_token"] !== "string") {
    throw new DriveliftError(`${path} has no refresh_token. Delete it and sign in again.`);
  }
  const token: StoredToken = { refresh_token: record["refresh_token"] };
  if (typeof record["access_token"] === "string") token.access_token = record["access_token"];
  if (typeof record["expires_at"] === "number") token.expires_at = record["expires_at"];
  if (typeof record["account"] === "string") token.account = record["account"];
  return token;
}

export function saveToken(configDir: string, token: StoredToken): void {
  ensureConfigDir(configDir);
  writePrivate(tokenPath(configDir), JSON.stringify(token, null, 2));
}

export function deleteToken(configDir: string): void {
  rmSync(tokenPath(configDir), { force: true });
}

/** 取り込み候補: ~/Downloads の client_secret*.json を新しい順に返す(実行はしない)。 */
export function findClientSecretCandidates(downloadsDir: string = join(homedir(), "Downloads")): Array<{ path: string; modified: string }> {
  if (!existsSync(downloadsDir)) return [];
  return readdirSync(downloadsDir)
    .filter((name) => /^client_secret.*\.json$/i.test(name))
    .map((name) => {
      const path = join(downloadsDir, name);
      return { path, mtime: statSync(path).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime)
    .map(({ path, mtime }) => ({ path, modified: new Date(mtime).toISOString() }));
}

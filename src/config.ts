/**
 * config.ts — 設定ディレクトリの読み書き。
 *
 * - 置き場所: $DRIVELIFT_CONFIG_DIR、無ければ ~/.config/drivelift
 * - client_secret.json: 次のログインに使うクライアント(Console からダウンロードした Desktop 種別の JSON をそのまま)
 * - accounts/<email>/: ログインしたアカウントごとの枠
 *   - client_secret.json: そのアカウントのログインに使ったクライアントの写し(refresh に要る。環境変数のクライアントなら作らない)
 *   - token.json: refresh_token とキャッシュした access_token、クライアントの出どころ(client_source)
 *   - sources.json: このアカウントに対応づけた到達元の配列
 * - token.json(トップレベル): 0.4.0 までの1枠の置き場所。各ツールの入口で accounts/ へ写す(0.4.0 が使い続けられるよう消さない)
 * - legacy-migration.json: token.json を写した・写せなかった印(その内容の sha256 と結果)。同じ内容では写し直さない
 * - 環境変数 DRIVELIFT_CLIENT_ID / DRIVELIFT_CLIENT_SECRET があればファイルより優先する(.mcp.json の env で渡す用途)
 *
 * secret を会話(LLM のコンテキスト)に通さないため、取り込みはファイルパス経由のみ。
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
  /** ログイン時に about.get で取れたメールアドレス。 */
  account?: string;
  /** ログインに使ったクライアントの出どころ。env なら refresh は環境変数のクライアントで行う。 */
  client_source?: ClientSource;
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

function legacyMigrationPath(configDir: string): string {
  return join(configDir, "legacy-migration.json");
}

export function accountsDir(configDir: string): string {
  return join(configDir, "accounts");
}

export function accountDir(configDir: string, email: string): string {
  return join(accountsDir(configDir), email);
}

function sourcesPath(accountDirPath: string): string {
  return join(accountDirPath, "sources.json");
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

function envCredentials(env: NodeJS.ProcessEnv): ClientCredentials | null {
  const envId = env["DRIVELIFT_CLIENT_ID"];
  const envSecret = env["DRIVELIFT_CLIENT_SECRET"];
  if (envId && envSecret) {
    return { clientId: envId, clientSecret: envSecret, source: "env" };
  }
  if (envId || envSecret) {
    throw new DriveliftError("Set both DRIVELIFT_CLIENT_ID and DRIVELIFT_CLIENT_SECRET, or neither (only one of them is set).");
  }
  return null;
}

function fileCredentials(dir: string): ClientCredentials | null {
  const path = clientSecretPath(dir);
  if (!existsSync(path)) return null;
  const { clientId, clientSecret } = parseClientSecret(readFileSync(path, "utf-8"));
  return { clientId, clientSecret, source: "file" };
}

/** 次のログインに使うクライアント。 */
export function loadClientCredentials(configDir: string, env: NodeJS.ProcessEnv = process.env): ClientCredentials | null {
  return envCredentials(env) ?? fileCredentials(configDir);
}

/** その枠のトークンを発行したクライアント。無ければ null(env で入ったのに環境変数が無い・写しが消えた)。 */
export function loadAccountCredentials(accountDirPath: string, token: StoredToken, env: NodeJS.ProcessEnv): ClientCredentials | null {
  return token.client_source === "env" ? envCredentials(env) : fileCredentials(accountDirPath);
}

function ensureConfigDir(configDir: string): void {
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
}

/** mode オプションは新規作成時にしか効かないので、既存ファイルにも書き込み後に明示的に 0600 を掛ける。 */
function writePrivate(path: string, text: string): void {
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** 検証済みの JSON テキストを所定パスへ 0600 で保存し、保存先を返す。ログイン済みの枠は各自の写しで refresh するので触らない。 */
export function saveClientSecret(configDir: string, text: string): { path: string } {
  parseClientSecret(text);
  ensureConfigDir(configDir);
  const path = clientSecretPath(configDir);
  writePrivate(path, text);
  return { path };
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
  if (record["client_source"] === "env" || record["client_source"] === "file") token.client_source = record["client_source"];
  return token;
}

export function saveToken(configDir: string, token: StoredToken): void {
  ensureConfigDir(configDir);
  writePrivate(tokenPath(configDir), JSON.stringify(token, null, 2));
}

/** email の枠にトークンとクライアントの写しを書く。同じ email の再ログインはこの枠だけを差し替える。 */
export function saveAccount(configDir: string, email: string, token: StoredToken, creds: ClientCredentials): void {
  const dir = accountDir(configDir, email);
  ensureConfigDir(dir);
  if (creds.source === "file") writePrivate(clientSecretPath(dir), JSON.stringify({ installed: { client_id: creds.clientId, client_secret: creds.clientSecret } }, null, 2));
  saveToken(dir, { ...token, account: email, client_source: creds.source });
}

export function listAccounts(configDir: string): string[] {
  const dir = accountsDir(configDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export function loadSources(accountDirPath: string): string[] {
  const path = sourcesPath(accountDirPath);
  if (!existsSync(path)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    throw new DriveliftError(`${path} is not valid JSON. Fix it (an array of strings) or delete it.`);
  }
  if (!Array.isArray(parsed) || !parsed.every((s): s is string => typeof s === "string")) {
    throw new DriveliftError(`${path} must be an array of strings. Fix it or delete it.`);
  }
  return parsed;
}

export function saveSources(accountDirPath: string, sources: string[]): void {
  writePrivate(sourcesPath(accountDirPath), JSON.stringify(sources, null, 2));
}

/** 0.4.0 の token.json を写した(migrated)・写せなかった(failed)印。sha256 はその時の token.json の内容。 */
export interface LegacyMigrationMark {
  sha256: string;
  outcome: "migrated" | "failed";
  email?: string;
  reason?: string;
  at: string;
}

/** 印。無い・読めない・形が違うときは null(写し直して書き直すだけなので、壊れた印は無いのと同じに扱う)。 */
export function loadLegacyMigration(configDir: string): LegacyMigrationMark | null {
  const path = legacyMigrationPath(configDir);
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const { sha256, outcome, email, reason, at } = record;
  if (typeof sha256 !== "string" || (outcome !== "migrated" && outcome !== "failed") || typeof at !== "string") return null;
  return { sha256, outcome, at, ...(typeof email === "string" ? { email } : {}), ...(typeof reason === "string" ? { reason } : {}) };
}

export function saveLegacyMigration(configDir: string, mark: LegacyMigrationMark): void {
  ensureConfigDir(configDir);
  writePrivate(legacyMigrationPath(configDir), JSON.stringify(mark, null, 2));
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

/**
 * core.ts — MCP サーバー(server.ts)と CLI(cli.ts)が共有するハンドラ。
 *
 * 各ハンドラは JSON 化できるオブジェクトを返し、失敗は DriveliftError を投げる。
 * 未設定・未ログイン・API 未有効化のときの DriveliftError は status(次の一手)を持つので、
 * 上位はそれをそのまま応答に載せればよい(利用者は upload をいきなり呼んでも誘導される)。
 *
 * 外部依存(設定ディレクトリ・fetch・時計・ブラウザ起動・cwd・git)は Deps で注入し、テストで差し替える。
 *
 * アカウントは accounts/<email>/ の枠ごとに持ち、upload は到達元(source.ts)から枠を引く。
 * 0.4.0 のトップレベル token.json は、枠を見る入口(status / upload / map_source)で accounts/ へ写す(消さない)。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { openBrowser } from "./browser.js";
import {
  accountDir,
  clientSecretPath,
  findClientSecretCandidates,
  listAccounts,
  loadAccountCredentials,
  loadClientCredentials,
  loadLegacyMigration,
  loadSources,
  loadToken,
  resolveConfigDir,
  saveAccount,
  saveClientSecret,
  saveLegacyMigration,
  saveSources,
  tokenPath,
  type ClientCredentials,
  type StoredToken,
} from "./config.js";
import { createPermission, DriveRequestError, driveAbout, ensureFolderPath, getFileMeta, MAX_SHARES, uploadToDrive, validateShare, type DriveFailure, type DriveFileMeta, type FetchLike, type ShareSpec } from "./drive.js";
import { defaultExecGcloud, runGcloudSetup, type ExecGcloud, type GcloudSetupInput, type GcloudSetupResult } from "./gcloud.js";
import { AccountUnresolvedError, DriveliftError, DriveliftInputError, TokenRefreshError } from "./errors.js";
import { CONVERT_MODES, defaultDriveName, extensionOf, resolveTargetMime, sourceMimeFor, type ConvertMode } from "./mime.js";
import { getAccessToken, refreshAccessToken, startLoginSession, type LoginSession } from "./oauth.js";
import { defaultGitOriginUrl, isPathSource, isTooBroadPath, matchSource, normalizeSourceInput, resolveAccount, sameSource, sourceKeyFor, sourceMatches, type AccountSources, type GitOriginUrl, type SourceKey } from "./source.js";
import { accountClientMissingStatus, accountUnresolvedStatus, apiDisabledStatus, noClientStatus, noTokenStatus, readyStatus, tokenInvalidStatus, type AccountSummary, type Status } from "./status.js";

export interface Deps {
  configDir: string;
  fetchImpl: FetchLike;
  now: () => number;
  env: NodeJS.ProcessEnv;
  openBrowser: (url: string) => Promise<boolean>;
  loginTimeoutMs: number;
  /** client_secret*.json を探すダウンロードディレクトリ。 */
  downloadsDir: string;
  /** gcloud CLI が使えるか。 */
  hasGcloud: () => boolean;
  /** gcloud の実行(gcloud_setup が confirm: true のときだけ使う)。 */
  execGcloud: ExecGcloud;
  /** status / map の到達元を求める作業ディレクトリ。 */
  cwd: string;
  gitOriginUrl: GitOriginUrl;
}

/** PATH 上に実行ファイルがあるか。Windows は .exe/.cmd も見る。 */
export function findOnPath(command: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const names = process.platform === "win32" ? [`${command}.exe`, `${command}.cmd`, command] : [command];
  return (env["PATH"] ?? "").split(delimiter).filter(Boolean).some((dir) => names.some((n) => existsSync(join(dir, n))));
}

export function defaultDeps(env: NodeJS.ProcessEnv = process.env): Deps {
  return {
    configDir: resolveConfigDir(env),
    fetchImpl: fetch,
    now: () => Date.now(),
    env,
    openBrowser,
    loginTimeoutMs: 10 * 60 * 1000,
    downloadsDir: join(homedir(), "Downloads"),
    hasGcloud: () => findOnPath("gcloud", env),
    execGcloud: defaultExecGcloud,
    cwd: process.cwd(),
    gitOriginUrl: defaultGitOriginUrl,
  };
}

// ---- gcloud ---------------------------------------------------------------

export function handleGcloudSetup(deps: Deps, input: GcloudSetupInput = {}): Promise<GcloudSetupResult> {
  return runGcloudSetup(input, { exec: deps.execGcloud, hasGcloud: deps.hasGcloud, secretPath: clientSecretPath(deps.configDir) });
}

function noClient(deps: Deps): Status {
  return noClientStatus(deps.configDir, { gcloud: deps.hasGcloud(), candidates: findClientSecretCandidates(deps.downloadsDir).map((c) => c.path) });
}

/** LLM は "~/..." をそのまま渡しがちなので、先頭の ~ だけ展開してから cwd 基準で解決する。 */
export function resolveUserPath(input: string, cwd: string): string {
  const expanded = input === "~" ? homedir() : input.startsWith("~/") ? `${homedir()}${input.slice(1)}` : input;
  return resolve(cwd, expanded);
}

function requireCreds(deps: Deps): ClientCredentials {
  const creds = loadClientCredentials(deps.configDir, deps.env);
  if (!creds) throw new DriveliftError("OAuth client is not configured.", noClient(deps));
  return creds;
}

function statusFromDriveFailure(deps: Deps, failure: DriveFailure, account: string | null): Status | null {
  if (failure.kind === "api_disabled") return apiDisabledStatus(deps.configDir, failure.enableUrl);
  if (failure.kind === "unauthorized") return tokenInvalidStatus(deps.configDir, `Drive API returned 401: ${failure.message}`, null, account);
  return null;
}

function sentence(text: string): string {
  return /[.!?)]$/.test(text) ? text : `${text}.`;
}

// ---- accounts -----------------------------------------------------------

/**
 * 0.4.0 のトップレベル token.json の扱い。
 * - none: 無い、またはクライアントが無くて写せない(status は no_client を案内し、取り込み後の次の呼び出しで写る)
 * - superseded: 写した(今・前に)、または同じアカウントの枠が既にある。以後は読まない
 * - failed: 写せなかった。status があればその状態、network は通信の失敗(状態は分からない)
 */
type LegacyOutcome = { kind: "none" } | { kind: "superseded" } | { kind: "failed"; message: string; status: Status | null; network: boolean };

/** Google が refresh を拒否して写せなかった。同じ内容では再試行しないので、消し方まで伝える。 */
function legacyRejected(configDir: string, reason: string, email: string | undefined): LegacyOutcome {
  const path = tokenPath(configDir);
  return {
    kind: "failed",
    message: `The previous sign-in${email ? ` of ${email}` : ""} (${path}) could not be copied to the per-account layout: Google rejected it (${reason}). drivelift will not try it again unless the file changes. If you no longer use drivelift 0.4.0, you can delete it (rm "${path}").`,
    status: tokenInvalidStatus(configDir, reason, reason.split(":", 1)[0] ?? null, email ?? null),
    network: false,
  };
}

/**
 * 0.4.0 のトップレベル token.json を accounts/<email>/ へ写す。0.4.0 のプロセスや drivelift@0 の利用者が使い続けられるよう、元は消さない。
 * 写す前に1回 refresh し、今のクライアントで通ることを確かめる(通らない組み合わせを枠にすると、以後ずっと token_invalid になる)。
 * 結果は token.json の内容のハッシュと一緒に印(legacy-migration.json)へ残し、同じ内容では写し直さない。通信の失敗は印を残さず次の呼び出しで再試行する。
 */
async function migrateLegacyToken(deps: Deps): Promise<LegacyOutcome> {
  const path = tokenPath(deps.configDir);
  if (!existsSync(path)) return { kind: "none" };
  const sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
  const mark = loadLegacyMigration(deps.configDir);
  if (mark?.sha256 === sha256) return mark.outcome === "migrated" ? { kind: "superseded" } : legacyRejected(deps.configDir, mark.reason ?? "unknown reason", mark.email);
  const creds = loadClientCredentials(deps.configDir, deps.env);
  if (!creds) return { kind: "none" };
  const failed = (reason: string, status: Status | null = null, network = false): LegacyOutcome => ({ kind: "failed", message: sentence(`The previous sign-in (${path}) could not be copied to the per-account layout: ${reason}`), status, network });
  let token: StoredToken | null;
  try {
    token = loadToken(deps.configDir);
  } catch (error) {
    if (error instanceof DriveliftError) return failed(error.message);
    throw error;
  }
  if (!token) return { kind: "none" };
  const record = (outcome: "migrated" | "failed", detail: { email?: string; reason?: string }): void => saveLegacyMigration(deps.configDir, { sha256, outcome, ...detail, at: new Date(deps.now()).toISOString() });
  const slots = listAccounts(deps.configDir);
  // 同じアカウントで先にログインし直していれば、その新しい枠を古いトークンで上書きしない。上書きしないので refresh で確かめる意味も無い
  if (token.account !== undefined && slots.includes(token.account)) {
    record("migrated", { email: token.account });
    return { kind: "superseded" };
  }
  try {
    const refreshed = await refreshAccessToken(creds, token, deps.fetchImpl, deps.now, deps.configDir);
    const email = token.account ?? (await driveAbout(refreshed.access_token, deps.fetchImpl)).emailAddress;
    if (!email) return failed("Drive did not return the account's email address.");
    if (!slots.includes(email)) saveAccount(deps.configDir, email, refreshed, creds);
    record("migrated", { email });
    return { kind: "superseded" };
  } catch (error) {
    if (error instanceof TokenRefreshError && (error.code === "invalid_grant" || error.code === "invalid_client")) {
      record("failed", { reason: error.reason, ...(token.account === undefined ? {} : { email: token.account }) });
      return legacyRejected(deps.configDir, error.reason, token.account);
    }
    if (error instanceof DriveRequestError) return failed(error.message, statusFromDriveFailure(deps, error.failure, token.account ?? null));
    if (error instanceof DriveliftError) return failed(error.message, error.status ?? null);
    if (error instanceof Error) return failed(`${error.name}: ${error.message}`, null, true);
    throw error;
  }
}

/** 写し終えた 0.4.0 の token.json について。消すかは利用者が決める(0.4.0 を併用していれば要る)。 */
function legacyNote(configDir: string): string {
  const path = tokenPath(configDir);
  return `${path} is the sign-in of drivelift 0.4.0 and earlier; 0.5.0 and later have copied it to accounts/ and no longer read it. If you only use 0.5.0 or later, you can delete it: rm "${path}"`;
}

function readAccounts(configDir: string): AccountSources[] {
  return listAccounts(configDir).map((email) => ({ email, sources: loadSources(accountDir(configDir, email)) }));
}

/**
 * ログイン済みの枠が無いときの Status(従来の no_client / no_token。0.4.0 のトークンを写せなければその理由の状態)。
 * 通信の失敗は状態が分からないので Status にせず投げる(no_token と報告すると、要らない再ログインに誘導する)。
 */
function noAccountStatus(deps: Deps, legacy: LegacyOutcome): Status {
  const creds = loadClientCredentials(deps.configDir, deps.env);
  if (!creds) return noClient(deps);
  if (legacy.kind !== "failed") return noTokenStatus(deps.configDir, creds.source);
  if (legacy.network) throw new DriveliftError(`${legacy.message} Check the network connection and try again.`);
  const status = legacy.status ?? noTokenStatus(deps.configDir, creds.source);
  return { ...status, message: `${legacy.message} ${status.message}` };
}

/** 枠が1つも無いときに送る・対応づける操作を止める例外(status と同じ状態を運ぶ)。 */
function noAccountError(deps: Deps, legacy: LegacyOutcome): DriveliftError {
  const status = noAccountStatus(deps, legacy);
  return new DriveliftError(status.state === "no_client" ? "OAuth client is not configured." : status.message, status);
}

interface AccountAccess {
  creds: ClientCredentials;
  dir: string;
}

/** 枠のクライアントとトークンの所在。使えなければ、その状態の Status を持つ DriveliftError。 */
function accountAccess(deps: Deps, email: string): AccountAccess {
  const dir = accountDir(deps.configDir, email);
  let token: StoredToken | null;
  try {
    token = loadToken(dir);
  } catch (error) {
    if (error instanceof DriveliftError) throw new DriveliftError(error.message, tokenInvalidStatus(deps.configDir, error.message, null, email));
    throw error;
  }
  if (!token) throw new DriveliftError(`${email} is not signed in.`, noTokenStatus(deps.configDir, null));
  const creds = loadAccountCredentials(dir, token, deps.env);
  if (!creds) {
    const status = accountClientMissingStatus(deps.configDir, email, token.client_source ?? "file", dir);
    throw new DriveliftError(status.message, status);
  }
  return { creds, dir };
}

async function accountStatus(deps: Deps, email: string): Promise<Status> {
  let access: AccountAccess;
  try {
    access = accountAccess(deps, email);
  } catch (error) {
    if (error instanceof DriveliftError && error.status) return error.status;
    throw error;
  }
  let token: Awaited<ReturnType<typeof getAccessToken>>;
  try {
    token = await getAccessToken(access.creds, access.dir, deps.fetchImpl, deps.now, deps.configDir);
  } catch (error) {
    if (error instanceof DriveliftError && error.status) return { ...error.status, client_source: access.creds.source };
    throw error;
  }
  if (!token) return noTokenStatus(deps.configDir, access.creds.source);
  try {
    await driveAbout(token.accessToken, deps.fetchImpl);
    return readyStatus(deps.configDir, email, access.creds.source);
  } catch (error) {
    if (error instanceof DriveRequestError) {
      const status = statusFromDriveFailure(deps, error.failure, email);
      if (status) return { ...status, client_source: access.creds.source };
    }
    throw error;
  }
}

// ---- status -------------------------------------------------------------

export async function handleStatus(deps: Deps): Promise<Status> {
  const legacy = await migrateLegacyToken(deps);
  const accounts = readAccounts(deps.configDir);
  const resolved = resolveAccount({ envAccount: deps.env["DRIVELIFT_ACCOUNT"], sourceKey: () => sourceKeyFor(deps.cwd, deps.gitOriginUrl), accounts });
  if (accounts.length === 0) return { ...noAccountStatus(deps, legacy), accounts: [], resolved };
  const statuses = new Map<string, Status>();
  const summaries: AccountSummary[] = [];
  for (const { email, sources } of accounts) {
    const status = await accountStatus(deps, email);
    statuses.set(email, status);
    summaries.push({ email, state: status.state as AccountSummary["state"], sources, client_source: status.client_source ?? null });
  }
  const top = resolved.account === null ? accountUnresolvedStatus(deps.configDir, resolved.reason) : (statuses.get(resolved.account) as Status);
  const note = legacy.kind === "failed" ? legacy.message : legacy.kind === "superseded" ? legacyNote(deps.configDir) : null;
  return { ...top, ...(note ? { message: `${top.message} ${note}` } : {}), accounts: summaries, resolved };
}

// ---- auth ---------------------------------------------------------------

type LoginOutcome = { kind: "pending" } | { kind: "completed"; account: string } | { kind: "failed"; message: string };

interface PendingLogin {
  session: LoginSession;
  startedAt: number;
  outcome: LoginOutcome;
}

/** MCP は1ツール呼び出しでブラウザ操作を待てない(タイムアウト)ので、開始と確認を分けてプロセス内に保持する。 */
let pendingLogin: PendingLogin | null = null;

export interface AuthStartResult {
  state: "pending" | "completed" | "failed";
  url: string;
  browser_opened: boolean;
  expires_in_seconds: number;
  account?: string;
  message: string;
  next: string;
}

/** 決着か wait_ms 経過のどちらか早い方まで待つ。決着していなければ pending のまま返す。 */
function waitForOutcome(entry: PendingLogin, waitMs: number): Promise<LoginOutcome> {
  if (waitMs <= 0 || entry.outcome.kind !== "pending") return Promise.resolve(entry.outcome);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(entry.outcome), waitMs);
    entry.session.done.then(
      () => {
        clearTimeout(timer);
        resolve(entry.outcome);
      },
      () => {
        clearTimeout(timer);
        resolve(entry.outcome);
      },
    );
  });
}

/** 多くの MCP クライアントのリクエスト既定タイムアウト(公式 SDK は 60 秒)に収まる長さにする。 */
export const DEFAULT_AUTH_WAIT_SECONDS = 45;
export const MAX_AUTH_WAIT_SECONDS = 600;

function clampWait(seconds: number | undefined, fallback: number): number {
  if (seconds === undefined) return fallback;
  return Math.max(0, Math.min(MAX_AUTH_WAIT_SECONDS, Math.floor(seconds)));
}

export async function handleAuthStart(deps: Deps, input: { open_browser?: boolean; wait_seconds?: number; login_hint?: string } = {}): Promise<AuthStartResult> {
  const creds = requireCreds(deps);
  if (input.login_hint !== undefined && input.login_hint.trim() === "") throw new DriveliftInputError("login_hint is empty. Omit it, or give the email address to sign in as.");
  if (pendingLogin && pendingLogin.outcome.kind === "pending") pendingLogin.session.cancel();
  const session = await startLoginSession({ creds, configDir: deps.configDir, fetchImpl: deps.fetchImpl, now: deps.now, timeoutMs: deps.loginTimeoutMs, ...(input.login_hint === undefined ? {} : { loginHint: input.login_hint }) });
  const entry: PendingLogin = { session, startedAt: deps.now(), outcome: { kind: "pending" } };
  pendingLogin = entry;
  session.done.then(
    (result) => {
      entry.outcome = { kind: "completed", account: result.account };
    },
    (error: unknown) => {
      entry.outcome = { kind: "failed", message: error instanceof Error ? error.message : String(error) };
    },
  );
  const browserOpened = input.open_browser === false ? false : await deps.openBrowser(session.url);
  // ブラウザでの同意が終わるまでここで待つ(既定 45 秒)。利用者が「終わった」と言わなくても完了が返る
  const outcome = await waitForOutcome(entry, clampWait(input.wait_seconds, DEFAULT_AUTH_WAIT_SECONDS) * 1000);
  const base = { url: session.url, browser_opened: browserOpened, expires_in_seconds: Math.round(deps.loginTimeoutMs / 1000) };
  switch (outcome.kind) {
    case "completed":
      return { ...base, state: "completed", account: outcome.account, message: `Signed in as ${outcome.account}.`, next: "You can call upload now." };
    case "failed":
      return { ...base, state: "failed", message: outcome.message, next: "Call auth_start to try again." };
    case "pending":
      return {
        ...base,
        state: "pending",
        message: browserOpened ? "A browser tab was opened but the sign-in has not finished yet." : "The sign-in has not finished yet.",
        next: browserOpened
          ? "Ask the user to finish the Google sign-in in the opened tab, then call auth_status (it can wait with wait_seconds)."
          : "Ask the user to open the URL in a browser and finish the Google sign-in, then call auth_status (it can wait with wait_seconds).",
      };
  }
}

export type AuthStatusResult =
  | { state: "idle"; message: string }
  | { state: "pending"; message: string; url: string; waited_seconds: number }
  | { state: "completed"; message: string; account: string }
  | { state: "failed"; message: string };

export async function handleAuthStatus(deps: Deps, input: { wait_seconds?: number } = {}): Promise<AuthStatusResult> {
  if (!pendingLogin) return { state: "idle", message: "No sign-in in progress. Call auth_start to begin, or status to see whether a token already exists." };
  const outcome = await waitForOutcome(pendingLogin, clampWait(input.wait_seconds, 0) * 1000);
  const { session, startedAt } = pendingLogin;
  switch (outcome.kind) {
    case "pending":
      return { state: "pending", message: "Waiting for the user to finish the sign-in in the browser.", url: session.url, waited_seconds: Math.round((deps.now() - startedAt) / 1000) };
    case "completed":
      return { state: "completed", message: `Signed in as ${outcome.account}. You can call upload now.`, account: outcome.account };
    case "failed":
      return { state: "failed", message: `${outcome.message} Call auth_start to try again.` };
  }
}

/** stdio 切断時などに、待ち受け中のログインを閉じる(ループバックサーバーが event loop を握ってプロセスが残るのを防ぐ)。 */
export function cancelPendingLogin(): void {
  if (pendingLogin && pendingLogin.outcome.kind === "pending") pendingLogin.session.cancel();
}

/** ログイン完了まで待つ(CLI 用)。MCP では使わない。 */
export async function waitForLogin(): Promise<{ account: string }> {
  if (!pendingLogin) throw new DriveliftError("No sign-in in progress.");
  return pendingLogin.session.done;
}

// ---- client secret ------------------------------------------------------

export type ImportClientSecretResult =
  | { imported: true; saved_to: string; next: string }
  | { imported: false; candidates: Array<{ path: string; modified: string }>; next: string };

export function handleImportClientSecret(deps: Deps, input: { path?: string } = {}): ImportClientSecretResult {
  if (input.path) {
    const path = resolveUserPath(input.path, deps.cwd);
    if (!existsSync(path)) throw new DriveliftError(`File not found: ${path}`);
    // FIFO や /dev/zero を同期読みするとイベントループごと止まるので、通常ファイル以外は読まない
    if (!statSync(path).isFile()) throw new DriveliftError(`Not a regular file: ${path}`);
    const { path: savedTo } = saveClientSecret(deps.configDir, readFileSync(path, "utf-8"));
    return { imported: true, saved_to: savedTo, next: "Call auth_start to sign in. Accounts already signed in keep using the client they signed in with." };
  }
  const candidates = findClientSecretCandidates(deps.downloadsDir);
  return {
    imported: false,
    candidates,
    next: candidates.length > 0
      ? "Ask the user which file to import (newest first), then call import_client_secret again with that path. Nothing was copied yet."
      : "No client_secret*.json found in ~/Downloads. Download the Desktop-app OAuth client JSON from Google Cloud Console first (see status for the URLs), then call import_client_secret with its path.",
  };
}

// ---- map source ---------------------------------------------------------

export interface MapSourceInput {
  account: string;
  /** 省略時は path(省略時は cwd)から到達元の鍵を求めて返すだけで、書かない。 */
  source?: string;
  path?: string;
  remove?: boolean;
}

export interface MapSourceResult {
  state: "candidate" | "added" | "removed" | "unchanged";
  account: string;
  source: string;
  /** 操作後の、この枠の到達元。 */
  sources: string[];
  message: string;
  next?: string;
}

/** 前方一致でほぼ全ファイルが当たる場所。シンボリックリンクの先(macOS の /tmp → /private/tmp 等)も含める。 */
function broadRoots(): string[] {
  return [homedir(), tmpdir(), "/tmp", "/var/tmp"].flatMap((root) => {
    try {
      return [root, realpathSync(root)];
    } catch {
      return [root];
    }
  });
}

/**
 * 対応づけるとほぼ全ファイルが当たる鍵か。パスはその場所、git remote は作業ツリーで判定する
 * (ホームを丸ごと git で管理していると、ホーム配下のどのファイルもその remote の鍵になる)。
 */
function tooBroadToMap(sourceKey: { key: string; gitRoot?: string }): boolean {
  const location = isPathSource(sourceKey.key) ? sourceKey.key : sourceKey.gitRoot;
  return location !== undefined && isTooBroadPath(location, broadRoots());
}

export async function handleMapSource(deps: Deps, input: MapSourceInput): Promise<MapSourceResult> {
  const legacy = await migrateLegacyToken(deps);
  const accounts = readAccounts(deps.configDir);
  if (accounts.length === 0) throw noAccountError(deps, legacy);
  const target = accounts.find((a) => a.email === input.account);
  if (!target) {
    throw new DriveliftInputError(`account ${input.account} is not signed in. Signed-in accounts: ${accounts.map((a) => a.email).join(", ") || "(none)"}. To add one, call auth_start with login_hint.`);
  }
  const { email: account, sources } = target;
  if (input.source === undefined) {
    const sourceKey = sourceKeyFor(input.path === undefined ? deps.cwd : resolveUserPath(input.path, deps.cwd), deps.gitOriginUrl);
    if (sourceKey.key === null) throw new DriveliftError(`Could not tell which source this is: ${sourceKey.error}`);
    const source = sourceKey.key;
    const tooBroad = !input.remove && tooBroadToMap(sourceKey);
    return {
      state: "candidate",
      account,
      source,
      sources,
      message: `Uploads from here are identified as ${source}. Nothing was written.`,
      next: input.remove
        ? `If the user wants to unmap it, call map_source again with source: "${source}" and remove: true.`
        : tooBroad
          ? `${source} cannot be mapped: it would match almost every file${sourceKey.gitRoot === undefined ? "" : ` (its working tree ${sourceKey.gitRoot} covers the home or temp directory)`}. Pass account to upload instead, or map a git repository or a narrower directory.`
          : `Ask the user whether uploads from ${source} should go to ${account}. Only if they agree, call map_source again with source: "${source}".`,
    };
  }
  const source = normalizeSourceInput(input.source);
  if (source === null) {
    throw new DriveliftInputError(`source must be a git remote including its host, like github.com/owner/repo, or an absolute path (got "${input.source}"). For a host without a dot (an internal git server), pass the clone URL, like git@gitserver:owner/repo or https://gitserver/owner/repo. Omit source to get the one for the current directory.`);
  }
  const dir = accountDir(deps.configDir, account);
  if (input.remove) {
    if (!sources.some((s) => sameSource(s, source))) return { state: "unchanged", account, source, sources, message: `${source} was not mapped to ${account}.` };
    const rest = sources.filter((s) => !sameSource(s, source));
    saveSources(dir, rest);
    return { state: "removed", account, source, sources: rest, message: `Unmapped ${source} from ${account}.` };
  }
  if (isPathSource(source)) {
    if (!existsSync(source)) {
      throw new DriveliftInputError(`${source} does not exist. A path is mapped by its real location (symlinks resolved, letter case as on disk), so it has to exist. Create the directory first, or map the git remote instead.`);
    }
    if (tooBroadToMap({ key: source })) {
      throw new DriveliftInputError(`${source} is too broad to map: as a prefix it would match almost every file (the filesystem root, the home or temp directory, or one of their parents). Map a git repository or a narrower directory.`);
    }
  } else {
    // 作業ツリーは remote 鍵だけからは分からないので、cwd の git の鍵と一致したときだけ判定する
    const here = sourceKeyFor(deps.cwd, deps.gitOriginUrl);
    if (here.key === source && here.gitRoot !== undefined && tooBroadToMap(here)) {
      throw new DriveliftInputError(`${source} is too broad to map: its working tree ${here.gitRoot} covers the home or temp directory, so almost every file there would be identified as ${source}. Pass account to upload instead.`);
    }
  }
  if (sources.some((s) => sameSource(s, source))) return { state: "unchanged", account, source, sources, message: `${source} is already mapped to ${account}.` };
  const owner = accounts.find((a) => a.email !== account && a.sources.some((s) => sameSource(s, source)));
  if (owner) {
    // 1回の呼び出しで付け替えられると、注入された1回の呼び出しで以後の送り先が恒久的に変わる
    throw new DriveliftInputError(`${source} is already mapped to ${owner.email}. To move it, first remove it from ${owner.email} (map_source with remove: true), then map it to ${account}. Ask the user before each step.`);
  }
  const added = [...sources, source];
  saveSources(dir, added);
  const overlaps = isPathSource(source)
    ? accounts.flatMap((a) => (a.email === account ? [] : a.sources.filter((s) => isPathSource(s) && (sourceMatches(s, source) || sourceMatches(source, s))).map((s) => `${s} (${a.email})`)))
    : [];
  return {
    state: "added",
    account,
    source,
    sources: added,
    message: `Mapped ${source} to ${account}.${overlaps.length > 0 ? ` It overlaps ${overlaps.join(", ")}. The longest matching mapping wins, so files under ${source} go to ${account} unless a longer mapping covers them.` : ""}`,
  };
}

// ---- upload -------------------------------------------------------------

export interface UploadInput {
  path: string;
  name?: string;
  folder_id?: string;
  /** "a/b" 形式。folder_id(省略時はマイドライブ直下)の下に探し、無ければ作る。 */
  folder_path?: string;
  convert?: ConvertMode;
  share?: ShareSpec[];
  /** user/group への共有で通知メールを送るか。既定 false。 */
  notify?: boolean;
  /** 新規作成せず、このファイル(drivelift が作ったもの)の中身を差し替える。URL・共有は保たれる。 */
  replace_id?: string;
  /** folder_path の末端フォルダを今回作ったなら、share と同じ共有をそのフォルダにも付ける。 */
  share_new_folder?: boolean;
  /** 送るアカウント(ログイン済みの枠のメールアドレス)。省略時は到達元から解決する。 */
  account?: string;
}

export interface ShareOutcome {
  role: string;
  type: string;
  target: string | null;
  ok: boolean;
  error?: string;
}

export interface UploadResult {
  id: string;
  name: string;
  mimeType: string;
  url: string;
  converted_to: string | null;
  account: string;
  /** アカウントの解決に使った到達元の鍵。引数・環境変数・唯一の枠で決まったときは null。 */
  source: string | null;
  /** account 引数で送り、到達元(git remote)がどの枠にも対応づいていないとき。利用者が承認したら map_source に渡す。 */
  suggest_map?: { source: string; account: string };
  /** account 引数で送ったが、到達元は別の枠に対応づいているとき、その枠。利用者が意図したアカウントか確かめる。 */
  mapped_to?: string;
  folder_id: string | null;
  folders_created: string[];
  shared: ShareOutcome[];
  /** folder_id(末端フォルダ)への共有の成否。share_new_folder 指定かつ末端を今回作ったときだけ入る。 */
  folder_shared: ShareOutcome[];
  /** replace_id で既存ファイルを差し替えたなら true。 */
  replaced: boolean;
}

export async function handleUpload(deps: Deps, input: UploadInput): Promise<UploadResult> {
  const convert = input.convert ?? "auto";
  if (!CONVERT_MODES.includes(convert)) throw new DriveliftInputError(`convert must be one of ${CONVERT_MODES.join(", ")}.`);
  const filePath = resolveUserPath(input.path, deps.cwd);
  if (!existsSync(filePath)) throw new DriveliftError(`File not found: ${filePath}`);
  if (!statSync(filePath).isFile()) throw new DriveliftError(`Not a regular file: ${filePath}`);

  // 指定の誤りは何も作る前に弾く(アップロード後に失敗すると中途半端な状態が残る)
  if (input.folder_id !== undefined && input.folder_id.trim() === "") throw new DriveliftInputError("folder_id is empty. Omit it to upload to My Drive root.");
  if (input.folder_path !== undefined && input.folder_path.trim() === "") throw new DriveliftInputError("folder_path is empty. Omit it, or give a path like Reports/2026-09.");
  if ((input.share?.length ?? 0) > MAX_SHARES) throw new DriveliftInputError(`share accepts at most ${MAX_SHARES} entries.`);
  for (const spec of input.share ?? []) validateShare(spec);
  if (input.replace_id !== undefined) {
    if (input.replace_id.trim() === "") throw new DriveliftInputError("replace_id is empty. Omit it to create a new file.");
    // 差し替えはファイルの場所を変えない。置き先の指定と組み合わせると、どちらが効いたか利用者が判断できない
    if (input.folder_id !== undefined || input.folder_path !== undefined) throw new DriveliftInputError("replace_id cannot be combined with folder_id or folder_path: a replaced file stays where it is.");
  }
  if (input.share_new_folder) {
    if (input.folder_path === undefined) throw new DriveliftInputError("share_new_folder needs folder_path: only a folder drivelift creates in this upload is shared.");
    if ((input.share?.length ?? 0) === 0) throw new DriveliftInputError("share_new_folder needs share: the folder gets the same permissions as the file.");
  }
  if (input.account !== undefined && input.account.trim() === "") throw new DriveliftInputError("account is empty. Omit it to pick the account from where the file is, or give a signed-in account's email.");

  const legacy = await migrateLegacyToken(deps);
  const accounts = readAccounts(deps.configDir);
  if (accounts.length === 0) throw noAccountError(deps, legacy);
  const sourceKey = (): SourceKey => sourceKeyFor(filePath, deps.gitOriginUrl);
  const resolution = resolveAccount({ requested: input.account, envAccount: deps.env["DRIVELIFT_ACCOUNT"], sourceKey, accounts });
  if (resolution.account === null) throw new AccountUnresolvedError(accountUnresolvedStatus(deps.configDir, resolution.reason), accounts.map((a) => a.email), resolution.source);
  const account = resolution.account;
  const mapping = resolution.by === "argument" ? argumentMapping(sourceKey(), account, accounts) : {};
  const { creds, dir } = accountAccess(deps, account);
  const access = await getAccessToken(creds, dir, deps.fetchImpl, deps.now, deps.configDir);
  if (!access) throw new DriveliftError("Not signed in.", noTokenStatus(deps.configDir, creds.source));

  const ext = extensionOf(filePath);
  const targetMime = resolveTargetMime(ext, convert);
  const name = input.name ?? defaultDriveName(filePath, targetMime !== null);
  let foldersCreated: string[] = [];
  let leafCreated = false;
  try {
    if (input.replace_id !== undefined) await checkReplaceTarget(access.accessToken, input.replace_id, name, targetMime ?? sourceMimeFor(ext), deps.fetchImpl);
    let folderId = input.folder_id;
    if (input.folder_path) {
      const folder = await ensureFolderPath(access.accessToken, input.folder_path, input.folder_id, deps.fetchImpl, (name) => foldersCreated.push(name));
      folderId = folder.id;
      leafCreated = folder.leafCreated;
    }
    const file = await uploadToDrive({
      accessToken: access.accessToken,
      filePath,
      name,
      sourceMime: sourceMimeFor(ext),
      targetMime,
      ...(folderId ? { folderId } : {}),
      ...(input.replace_id !== undefined ? { replaceId: input.replace_id } : {}),
      fetchImpl: deps.fetchImpl,
    });
    // 共有はファイルができた後なので、1件の失敗で全体を失敗にしない(ファイルは残る)。件ごとの成否を返す
    // 大きいファイルの送信中に access_token が切れていることがあるので、共有の前に取り直す(期限内ならキャッシュが返る)
    // 取り直しに失敗しても、ファイルはもうできているので呼び出し全体は失敗にしない(再試行で二重アップロードになる)。各共有の失敗として返す
    let shareToken: string | null = access.accessToken;
    let tokenError: string | null = null;
    if ((input.share?.length ?? 0) > 0) {
      try {
        shareToken = (await getAccessToken(creds, dir, deps.fetchImpl, deps.now, deps.configDir))?.accessToken ?? null;
        if (!shareToken) tokenError = "not signed in";
      } catch (error) {
        shareToken = null;
        tokenError = `could not refresh the access token before sharing: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    const shareTo = async (targetId: string): Promise<ShareOutcome[]> => {
      const outcomes: ShareOutcome[] = [];
      for (const spec of input.share ?? []) {
        const base = { role: spec.role, type: spec.type, target: spec.target ?? null };
        if (!shareToken) {
          outcomes.push({ ...base, ok: false, error: tokenError ?? "no access token" });
          continue;
        }
        try {
          await createPermission(shareToken, targetId, spec, input.notify ?? false, deps.fetchImpl);
          outcomes.push({ ...base, ok: true });
        } catch (error) {
          outcomes.push({ ...base, ok: false, error: error instanceof DriveRequestError && error.failure.kind !== "other" && error.failure.kind !== "api_disabled" ? `${error.failure.kind}: ${error.failure.message}` : error instanceof Error ? error.message : String(error) });
        }
      }
      return outcomes;
    };
    const shared = await shareTo(file.id);
    // 末端を今回作ったときだけ。再利用したフォルダには以前のファイルが入りうるので、共有すると継承でそれらまで見えてしまう
    // 途中を作っても、別プロセスが同時に末端を作っていれば末端は再利用になるので、末端そのものの作成で判定する
    const folderShared = input.share_new_folder && folderId && leafCreated ? await shareTo(folderId) : [];
    return {
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
      url: file.webViewLink,
      converted_to: targetMime,
      account,
      source: resolution.by === "source" ? resolution.source : null,
      ...mapping,
      folder_id: folderId ?? null,
      folders_created: foldersCreated,
      shared,
      folder_shared: folderShared,
      replaced: input.replace_id !== undefined,
    };
  } catch (error) {
    // フォルダを作った後で失敗しても、作ったフォルダは残る。利用者が掃除できるよう伝える
    const leftover = foldersCreated.length > 0 ? ` (folders already created before the failure: ${foldersCreated.join("/")})` : "";
    try {
      rethrowUploadError(deps, error, input.replace_id !== undefined, account);
    } catch (e) {
      if (!leftover) throw e;
      if (e instanceof DriveliftError) throw new DriveliftError(`${e.message}${leftover}`, e.status);
      // タイムアウト(DOMException)やネットワーク断(TypeError)でも、作ったフォルダは伝える
      throw new DriveliftError(`${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}${leftover}`);
    }
  }
}

/**
 * account 引数で送ったときの、到達元の対応づけとの関係。
 * suggest_map は git remote の鍵だけ。パスの対応づけは前方一致で広く効くので、利用者が明示したときだけ作る。
 * 作業ツリーがホーム等を丸ごと含む remote も、対応づけるとほぼ全ファイルが当たるので出さない。
 */
function argumentMapping(sourceKey: SourceKey, account: string, accounts: AccountSources[]): Pick<UploadResult, "suggest_map" | "mapped_to"> {
  if (sourceKey.key === null) return {};
  const mapped = matchSource(sourceKey.key, accounts);
  if (mapped.length === 0) return isPathSource(sourceKey.key) || tooBroadToMap(sourceKey) ? {} : { suggest_map: { source: sourceKey.key, account } };
  return mapped.includes(account) ? {} : { mapped_to: mapped.join(", ") };
}

/**
 * 差し替え先の取り違えを送信前に止める。ID を控えた md をコピーして別のレポートを作った場合(名前が違う)、
 * ゴミ箱に入れたファイル(更新は成功するが誰も開けない)、種類の違うファイル(Sheets に docx 等)を拒否する。
 */
async function checkReplaceTarget(accessToken: string, fileId: string, name: string, expectedMime: string, fetchImpl: FetchLike): Promise<void> {
  let meta: DriveFileMeta;
  try {
    meta = await getFileMeta(accessToken, fileId, fetchImpl);
  } catch (error) {
    if (error instanceof DriveRequestError && error.failure.kind === "not_found") {
      throw new DriveliftInputError(`replace_id ${fileId} was not found. drivelift can only replace files it created itself (drive.file scope), and the file may have been deleted.`);
    }
    throw error;
  }
  if (meta.trashed) throw new DriveliftInputError(`replace_id ${fileId} ("${meta.name}") is in the trash. Restore it in Drive, or omit replace_id to create a new file.`);
  // 見た目が同じでも NFC/NFD で別の文字列になる(macOS のファイル名は NFD になりうる)ので正規化して比べる
  if (meta.name.normalize("NFC") !== name.normalize("NFC")) {
    // 回避方法(名前の指定)は書かない。取り違え防止のガードなので、LLM が自動で再試行して外すのを誘わない
    throw new DriveliftInputError(`replace_id ${fileId} is named "${meta.name}", but this upload would be named "${name}". Refusing to replace what may be a different file. Ask the user whether this is really the same document before retrying.`);
  }
  if (meta.mimeType !== expectedMime) throw new DriveliftInputError(`replace_id ${fileId} is ${meta.mimeType}, but this upload would become ${expectedMime}. A file can only be replaced with content of the same kind.`);
}

function rethrowUploadError(deps: Deps, error: unknown, replacing: boolean, account: string): never {
  if (error instanceof DriveRequestError) {
    const status = statusFromDriveFailure(deps, error.failure, account);
    if (status) throw new DriveliftError(error.message, status);
    // 事前確認の後に消された・ゴミ箱を空にされた場合。folder_id は併用できないので、フォルダの案内は出さない
    if (error.failure.kind === "not_found" && replacing) throw new DriveliftError(`Drive returned 404 while replacing (${error.failure.message}). The file was removed after drivelift checked it; omit replace_id to create a new file.`);
    if (error.failure.kind === "not_found") throw new DriveliftError(`Drive returned 404 (${error.failure.message}). If you passed folder_id: check that the ID is right (the part after /folders/ in the folder URL) and that the signed-in account can edit that folder. drivelift can create files in any folder the account can edit, even though it cannot list that folder's contents.`);
  }
  throw error;
}

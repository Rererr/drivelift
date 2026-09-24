/**
 * oauth.ts — Google OAuth 2.0 の「インストール済みアプリ + ループバック」フロー。
 *
 * 1. 127.0.0.1 の空きポートで HTTP を待ち受け、その URL を redirect_uri にして認可 URL を組む(PKCE 付き)
 * 2. ブラウザで同意が済むと Google がそのポートへ code を返す
 * 3. code を token endpoint で refresh_token / access_token に交換し token.json に保存する
 *
 * Desktop 種別のクライアントは redirect_uri の事前登録なしにループバックの任意ポートを許すため、
 * ホスティングも固定ポートも要らない。
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ClientCredentials, StoredToken } from "./config.js";
import { loadToken, saveToken } from "./config.js";
import { driveAbout, type FetchLike } from "./drive.js";
import { DriveliftError } from "./errors.js";
import { tokenInvalidStatus } from "./status.js";

export const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
/** access_token の残り寿命がこれ未満なら先に refresh する(リクエスト途中の失効を避ける)。 */
const EXPIRY_MARGIN_MS = 60_000;

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  error?: string;
  error_description?: string;
}

async function postToken(fetchImpl: FetchLike, params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetchImpl(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  try {
    return JSON.parse(text) as TokenResponse;
  } catch {
    throw new DriveliftError(`Google token endpoint returned a non-JSON response (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
}

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export interface LoginResult {
  account: string | null;
}

export interface LoginSession {
  /** 利用者がブラウザで開く認可 URL。 */
  url: string;
  port: number;
  /** ブラウザでの同意完了(または失敗・タイムアウト)で決着する。 */
  done: Promise<LoginResult>;
  cancel(): void;
}

export interface StartLoginOptions {
  creds: ClientCredentials;
  configDir: string;
  fetchImpl: FetchLike;
  now: () => number;
  timeoutMs: number;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

/** title/body は外部由来(Google の error 値・エラーメッセージ)を含みうるので必ずエスケープする。 */
function htmlPage(title: string, body: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title><body style="font-family:system-ui;max-width:32rem;margin:4rem auto"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></body>`;
}

/** ループバック HTTP サーバーを立て、認可 URL を返す。 */
export async function startLoginSession(opts: StartLoginOptions): Promise<LoginSession> {
  const { verifier, challenge } = pkcePair();
  const state = randomBytes(16).toString("base64url");

  let resolveDone!: (r: LoginResult) => void;
  let rejectDone!: (e: Error) => void;
  const done = new Promise<LoginResult>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  let settled = false;
  /** code 交換中に同じコールバックが再送(タブ再読込等)されても二重交換しない。 */
  let exchanging = false;
  let server: Server;
  let timer: NodeJS.Timeout | undefined;
  const finish = (outcome: { ok: true; result: LoginResult } | { ok: false; error: Error }): void => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    server.close();
    if (outcome.ok) resolveDone(outcome.result);
    else rejectDone(outcome.error);
  };

  const port = await new Promise<number>((resolve, reject) => {
    server = createServer((req, res) => {
      let url: URL;
      try {
        url = new URL(req.url ?? "/", "http://127.0.0.1");
      } catch {
        // 壊れたリクエスト行(ブラウザからは送れない形)で待ち受けごとプロセスを落とさない
        res.writeHead(400).end();
        return;
      }
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      // state を最初に照合する。Google はエラー時も state を返すので、state の無いリクエスト
      // (他サイトからのポート総当たり等)は成功・失敗どちらにも進めず無視して待ち続ける
      if (url.searchParams.get("state") !== state) {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end("invalid callback");
        return;
      }
      const error = url.searchParams.get("error");
      if (error) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" }).end(htmlPage("drivelift: sign-in failed", `Google returned: ${error}. You can close this tab.`));
        finish({ ok: false, error: new DriveliftError(`Google sign-in was not completed: ${error}`) });
        return;
      }
      const code = url.searchParams.get("code");
      if (!code) {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end("invalid callback");
        return;
      }
      if (exchanging) {
        res.writeHead(409, { "Content-Type": "text/plain; charset=utf-8" }).end("sign-in already in progress");
        return;
      }
      exchanging = true;
      void exchangeCode(code)
        .then((result) => {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(htmlPage("drivelift: signed in", `${result.account ? `Signed in as ${result.account}. ` : ""}You can close this tab and return to your agent.`));
          finish({ ok: true, result });
        })
        .catch((err: unknown) => {
          const e = err instanceof Error ? err : new Error(String(err));
          res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" }).end(htmlPage("drivelift: sign-in failed", `${e.message} You can close this tab.`));
          finish({ ok: false, error: e });
        });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });

  const redirectUri = `http://127.0.0.1:${port}/callback`;

  async function exchangeCode(code: string): Promise<LoginResult> {
    const body = await postToken(opts.fetchImpl, {
      code,
      client_id: opts.creds.clientId,
      client_secret: opts.creds.clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      code_verifier: verifier,
    });
    if (body.error || !body.access_token || !body.refresh_token) {
      throw new DriveliftError(`Token exchange failed: ${body.error ?? "no refresh_token in response"}${body.error_description ? ` (${body.error_description})` : ""}. If refresh_token is missing, revoke drivelift at https://myaccount.google.com/permissions and sign in again.`);
    }
    const token: StoredToken = {
      refresh_token: body.refresh_token,
      access_token: body.access_token,
      expires_at: opts.now() + (body.expires_in ?? 3600) * 1000,
    };
    // メールアドレスは表示用。Drive API 未有効化などで取れなくてもログイン自体は成立させる
    let account: string | null = null;
    try {
      account = (await driveAbout(body.access_token, opts.fetchImpl)).emailAddress;
    } catch {
      account = null;
    }
    if (account) token.account = account;
    saveToken(opts.configDir, token);
    return { account };
  }

  const params = new URLSearchParams({
    client_id: opts.creds.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: DRIVE_FILE_SCOPE,
    access_type: "offline",
    // 既に同意済みのアカウントでも refresh_token を再発行させる
    prompt: "consent",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });

  timer = setTimeout(() => finish({ ok: false, error: new DriveliftError(`Sign-in timed out after ${Math.round(opts.timeoutMs / 1000)}s. Call auth_start again.`) }), opts.timeoutMs);
  timer.unref();

  return {
    url: `${AUTH_ENDPOINT}?${params.toString()}`,
    port,
    done,
    cancel: () => finish({ ok: false, error: new DriveliftError("Sign-in was cancelled.") }),
  };
}

export async function refreshAccessToken(creds: ClientCredentials, token: StoredToken, fetchImpl: FetchLike, now: () => number, configDir: string): Promise<StoredToken & { access_token: string }> {
  const body = await postToken(fetchImpl, {
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    refresh_token: token.refresh_token,
    grant_type: "refresh_token",
  });
  if (body.error || !body.access_token) {
    const reason = body.error ? `${body.error}${body.error_description ? `: ${body.error_description}` : ""}` : "no access_token in response";
    throw new DriveliftError(`Token refresh failed (${reason}).`, tokenInvalidStatus(configDir, reason, body.error ?? null));
  }
  const refreshed: StoredToken & { access_token: string } = {
    ...token,
    refresh_token: body.refresh_token ?? token.refresh_token,
    access_token: body.access_token,
    expires_at: now() + (body.expires_in ?? 3600) * 1000,
  };
  saveToken(configDir, refreshed);
  return refreshed;
}

/** 有効な access_token を返す(期限が近ければ refresh)。token.json が無ければ null。 */
export async function getAccessToken(creds: ClientCredentials, configDir: string, fetchImpl: FetchLike, now: () => number): Promise<{ accessToken: string; token: StoredToken } | null> {
  const stored = loadToken(configDir);
  if (!stored) return null;
  if (stored.access_token && stored.expires_at && stored.expires_at - EXPIRY_MARGIN_MS > now()) {
    return { accessToken: stored.access_token, token: stored };
  }
  const refreshed = await refreshAccessToken(creds, stored, fetchImpl, now, configDir);
  return { accessToken: refreshed.access_token, token: refreshed };
}

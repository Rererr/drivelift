import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadToken, saveToken, type ClientCredentials } from "../src/config.js";
import type { FetchLike } from "../src/drive.js";
import { DriveliftError } from "../src/errors.js";
import { getAccessToken, refreshAccessToken, startLoginSession } from "../src/oauth.js";

const creds: ClientCredentials = { clientId: "cid", clientSecret: "csec", source: "file" };
const NOW = 1_700_000_000_000;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "drivelift-oauth-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** token endpoint と about.get だけを模した fetch。呼び出しを記録する。 */
function googleFetch(overrides: { token?: () => Response; about?: () => Response } = {}): { fetchImpl: FetchLike; calls: Array<{ url: string; body: string }> } {
  const calls: Array<{ url: string; body: string }> = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = String(input);
    calls.push({ url, body: String(init?.body ?? "") });
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      return overrides.token?.() ?? new Response(JSON.stringify({ access_token: "acc", refresh_token: "ref", expires_in: 3600 }), { status: 200 });
    }
    if (url.includes("/drive/v3/about")) {
      return overrides.about?.() ?? new Response(JSON.stringify({ user: { emailAddress: "me@example.com" } }), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  return { fetchImpl, calls };
}

describe("startLoginSession", () => {
  it("ループバックの redirect_uri と PKCE を含む認可 URL を返し、正しい state のコールバックでトークンを保存する", async () => {
    const { fetchImpl, calls } = googleFetch();
    const session = await startLoginSession({ creds, configDir: dir, fetchImpl, now: () => NOW, timeoutMs: 5_000 });
    const url = new URL(session.url);
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("redirect_uri")).toBe(`http://127.0.0.1:${session.port}/callback`);
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/drive.file");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("access_type")).toBe("offline");
    const state = url.searchParams.get("state");
    expect(state).toBeTruthy();

    // state 不一致は 400 を返すだけで待ち受けは続く
    const bad = await fetch(`http://127.0.0.1:${session.port}/callback?code=x&state=wrong`);
    expect(bad.status).toBe(400);
    expect(calls).toHaveLength(0);

    const good = await fetch(`http://127.0.0.1:${session.port}/callback?code=CODE&state=${state}`);
    expect(good.status).toBe(200);
    expect(await good.text()).toContain("me@example.com");
    await expect(session.done).resolves.toEqual({ account: "me@example.com" });

    const tokenCall = calls.find((c) => c.url.includes("/token"));
    const params = new URLSearchParams(tokenCall?.body);
    expect(params.get("code")).toBe("CODE");
    expect(params.get("grant_type")).toBe("authorization_code");
    expect(params.get("code_verifier")).toBeTruthy();
    expect(params.get("redirect_uri")).toBe(`http://127.0.0.1:${session.port}/callback`);
    expect(loadToken(dir)).toEqual({ refresh_token: "ref", access_token: "acc", expires_at: NOW + 3_600_000, account: "me@example.com" });

    // 決着後はサーバーが閉じている
    await expect(fetch(`http://127.0.0.1:${session.port}/callback`)).rejects.toThrow();
  });

  it("Google が state 付きで error を返したら失敗で決着する", async () => {
    const { fetchImpl } = googleFetch();
    const session = await startLoginSession({ creds, configDir: dir, fetchImpl, now: () => NOW, timeoutMs: 5_000 });
    const failed = session.done.catch((e: unknown) => e);
    const state = new URL(session.url).searchParams.get("state");
    const res = await fetch(`http://127.0.0.1:${session.port}/callback?error=access_denied&state=${state}`);
    expect(res.status).toBe(400);
    await expect(failed).resolves.toBeInstanceOf(DriveliftError);
    expect(loadToken(dir)).toBeNull();
  });

  it("state の無い error リクエストは無視して待ち続ける(他サイトからの妨害を通さない)", async () => {
    const { fetchImpl } = googleFetch();
    const session = await startLoginSession({ creds, configDir: dir, fetchImpl, now: () => NOW, timeoutMs: 5_000 });
    let settled = false;
    session.done.then(() => (settled = true), () => (settled = true));
    const res = await fetch(`http://127.0.0.1:${session.port}/callback?error=access_denied`);
    expect(res.status).toBe(400);
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
    // まだ待ち受けているので、正規のコールバックで成功できる
    const state = new URL(session.url).searchParams.get("state");
    await fetch(`http://127.0.0.1:${session.port}/callback?code=C&state=${state}`);
    await expect(session.done).resolves.toEqual({ account: "me@example.com" });
  });

  it("応答 HTML に外部由来の値を埋めるときはエスケープする", async () => {
    const { fetchImpl } = googleFetch();
    const session = await startLoginSession({ creds, configDir: dir, fetchImpl, now: () => NOW, timeoutMs: 5_000 });
    session.done.catch(() => undefined);
    const state = new URL(session.url).searchParams.get("state");
    const res = await fetch(`http://127.0.0.1:${session.port}/callback?state=${state}&error=${encodeURIComponent("<script>alert(1)</script>")}`);
    const html = await res.text();
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("交換中に同じコールバックが再送されても二重交換せず 409 を返す", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let tokenCalls = 0;
    const fetchImpl: FetchLike = async (input) => {
      const url = String(input);
      if (url.includes("/token")) {
        tokenCalls += 1;
        await gate;
        return new Response(JSON.stringify({ access_token: "acc", refresh_token: "ref", expires_in: 3600 }));
      }
      return new Response(JSON.stringify({ user: { emailAddress: "me@example.com" } }));
    };
    const session = await startLoginSession({ creds, configDir: dir, fetchImpl, now: () => NOW, timeoutMs: 5_000 });
    const state = new URL(session.url).searchParams.get("state");
    const first = fetch(`http://127.0.0.1:${session.port}/callback?code=C&state=${state}`);
    await new Promise((r) => setTimeout(r, 20));
    const second = await fetch(`http://127.0.0.1:${session.port}/callback?code=C&state=${state}`);
    expect(second.status).toBe(409);
    release();
    expect((await first).status).toBe(200);
    await expect(session.done).resolves.toEqual({ account: "me@example.com" });
    expect(tokenCalls).toBe(1);
  });

  it("refresh_token が返らない交換は失敗として扱う", async () => {
    const { fetchImpl } = googleFetch({ token: () => new Response(JSON.stringify({ access_token: "acc", expires_in: 10 }), { status: 200 }) });
    const session = await startLoginSession({ creds, configDir: dir, fetchImpl, now: () => NOW, timeoutMs: 5_000 });
    const failed = session.done.catch((e: unknown) => e);
    const state = new URL(session.url).searchParams.get("state");
    const res = await fetch(`http://127.0.0.1:${session.port}/callback?code=C&state=${state}`);
    expect(res.status).toBe(500);
    const error = (await failed) as Error;
    expect(error.message).toMatch(/refresh_token/);
  });

  it("タイムアウトで失敗し、cancel も同じ経路で決着する", async () => {
    const { fetchImpl } = googleFetch();
    const timed = await startLoginSession({ creds, configDir: dir, fetchImpl, now: () => NOW, timeoutMs: 20 });
    await expect(timed.done).rejects.toThrow(/timed out/);
    const cancelled = await startLoginSession({ creds, configDir: dir, fetchImpl, now: () => NOW, timeoutMs: 5_000 });
    cancelled.cancel();
    await expect(cancelled.done).rejects.toThrow(/cancelled/);
  });
});

describe("refreshAccessToken / getAccessToken", () => {
  it("有効期限内の access_token はネットワークを使わずそのまま返す", async () => {
    saveToken(dir, { refresh_token: "ref", access_token: "acc", expires_at: NOW + 120_000 });
    const { fetchImpl, calls } = googleFetch();
    const result = await getAccessToken(creds, dir, fetchImpl, () => NOW);
    expect(result?.accessToken).toBe("acc");
    expect(calls).toHaveLength(0);
  });

  it("期限切れなら refresh し、保存し直す", async () => {
    saveToken(dir, { refresh_token: "ref", access_token: "old", expires_at: NOW + 10_000 });
    const { fetchImpl, calls } = googleFetch({ token: () => new Response(JSON.stringify({ access_token: "new", expires_in: 100 }), { status: 200 }) });
    const result = await getAccessToken(creds, dir, fetchImpl, () => NOW);
    expect(result?.accessToken).toBe("new");
    expect(new URLSearchParams(calls[0]?.body).get("grant_type")).toBe("refresh_token");
    expect(loadToken(dir)).toMatchObject({ refresh_token: "ref", access_token: "new", expires_at: NOW + 100_000 });
  });

  it("invalid_client は再ログインでなくクライアント JSON の取り直しを案内する", async () => {
    const { fetchImpl } = googleFetch({ token: () => new Response(JSON.stringify({ error: "invalid_client", error_description: "The OAuth client was deleted." }), { status: 401 }) });
    const error = await refreshAccessToken(creds, { refresh_token: "ref" }, fetchImpl, () => NOW, dir).catch((e: unknown) => e as DriveliftError);
    expect(error).toBeInstanceOf(DriveliftError);
    expect(error.status?.state).toBe("token_invalid");
    expect(error.status?.next_steps.join("\n")).toMatch(/import_client_secret/);
    expect(error.status?.next_steps.join("\n")).not.toMatch(/7 days/);
  });

  it("invalid_grant は token_invalid の Status を伴う DriveliftError", async () => {
    const { fetchImpl } = googleFetch({ token: () => new Response(JSON.stringify({ error: "invalid_grant", error_description: "Token has been expired or revoked." }), { status: 400 }) });
    await expect(refreshAccessToken(creds, { refresh_token: "ref" }, fetchImpl, () => NOW, dir)).rejects.toMatchObject({ status: { state: "token_invalid" } });
  });

  it("token.json が無ければ null", async () => {
    const { fetchImpl } = googleFetch();
    expect(await getAccessToken(creds, dir, fetchImpl, () => NOW)).toBeNull();
  });
});

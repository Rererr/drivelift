/**
 * errors.ts — drivelift の例外型。
 *
 * ツール/CLI の失敗は「何が起きたか」だけでなく「次に何をすればよいか」を運ぶ。
 * status を伴う DriveliftError は、その状態(未設定・未ログイン・API無効化 等)を
 * そのまま構造化して呼び出し側(LLM/人)へ返せる。
 */
import type { Status } from "./status.js";

export class DriveliftError extends Error {
  readonly status: Status | undefined;

  constructor(message: string, status?: Status) {
    super(message);
    this.name = "DriveliftError";
    this.status = status;
  }

  /** ツール応答(JSON)へ載せる形。status があれば next_steps / urls を同梱する。 */
  toPayload(): Record<string, unknown> {
    return this.status ? { error: this.message, ...this.status } : { error: this.message };
  }
}

/** token endpoint が refresh を拒否した。code は Google の OAuth エラーコード(応答に無ければ null)、reason はそれと説明。 */
export class TokenRefreshError extends DriveliftError {
  readonly code: string | null;
  readonly reason: string;

  constructor(message: string, status: Status, code: string | null, reason: string) {
    super(message, status);
    this.name = "TokenRefreshError";
    this.code = code;
    this.reason = reason;
  }
}

/** 呼び出し側の指定の誤り(何も実行する前に弾いたもの)。CLI では使い方の誤りとして終了コード 2 にする。 */
export class DriveliftInputError extends DriveliftError {
  constructor(message: string, status?: Status) {
    super(message, status);
    this.name = "DriveliftInputError";
  }
}

/**
 * どのアカウントで送るか決まらず、送信前に拒否した。応答に選べる枠(candidates)と到達元の鍵を載せ、利用者に選ばせる。
 * source は鍵を求めなかった・求められなかったとき null。
 */
export class AccountUnresolvedError extends DriveliftInputError {
  readonly candidates: string[];
  readonly source: string | null;

  constructor(status: Status, candidates: string[], source: string | null) {
    super(status.message, status);
    this.name = "AccountUnresolvedError";
    this.candidates = candidates;
    this.source = source;
  }

  override toPayload(): Record<string, unknown> {
    return { ...super.toPayload(), candidates: this.candidates, source: this.source };
  }
}

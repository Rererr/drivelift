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

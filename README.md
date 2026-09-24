# drivelift

ローカルのファイルを Google Drive へ持ち上げ、Google スプレッドシート／ドキュメント／スライドとして置く MCP サーバー兼 CLI。LLM エージェント（Claude Code、Cursor、Codex など）が作った xlsx や md を、書式を保ったまま Drive の URL にする。

[English](README.en.md)

## 何を解くか

エージェントが手元に書いた成果物を Drive に載せたい場面で、既存の Drive コネクタはローカルファイルを受け取れない。中身を base64 にして会話に通すと、数十 KB のバイナリでも壊れる。

drivelift は利用者のマシンで動き、ツールにファイルパスを渡すだけで済む。バイト列は会話を通らず、Drive API へ直接流れる。xlsx から Google スプレッドシートへの変換は Drive 自身のインポート機能で行うので、列幅・塗り・タブ・埋め込み画像のような書式はその機能が保つ範囲でそのまま残る（rclone の `--drive-import-formats` と同じ経路）。

## 設計上の約束

- **共有の OAuth クライアントを持たない。** 利用者が自分の Google Cloud プロジェクトでクライアントを作る（5 分程度）。未設定のときはツールが Console の URL を順に返して誘導する
- **スコープは `drive.file` だけ。** drivelift が作ったファイル以外は見えない。既存の共有資料を壊す経路がない
- **secret を会話に通さない。** クライアント JSON の取り込みはファイルパス指定のみ
- **ホスティング不要。** ループバック（127.0.0.1）でログインし、トークンは手元に置く
- 依存は MCP SDK と zod の 2 つ。Drive API は標準の `fetch` で叩く

## 導入

Claude Code の場合、プロジェクトの `.mcp.json` に追加する。

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

または `claude mcp add drivelift -- npx -y drivelift@0`。CLI として使うなら `npx drivelift doctor`。

Node.js 22.13 以降が必要。

## 初回セットアップ

エージェントに「drivelift の status を見て」と言えば、以下を返してくる。手順を自分で踏む場合は同じ内容。

1. Google Cloud プロジェクトを作る（既存でも可）: https://console.cloud.google.com/projectcreate 。gcloud が入っていれば `gcloud_setup` ツール（CLI: `drivelift setup-gcloud --yes`）が手順 1・2 を代理実行する。実行前に打つコマンドを見せて承認を求める。手順 3・4 に gcloud の代替はない
2. Google Drive API を有効化: https://console.cloud.google.com/apis/library/drive.googleapis.com
3. OAuth 同意画面を設定: https://console.cloud.google.com/auth/overview
   - Google Workspace のアカウントなら **内部**（審査不要、トークン失効なし）
   - 個人 Gmail なら **外部** にして **本番に公開**する。テスト状態のままだとリフレッシュトークンが 7 日で失効する
4. OAuth クライアントを **デスクトップ アプリ** 種別で作り、JSON をダウンロード: https://console.cloud.google.com/auth/clients/create
5. JSON を所定の場所に置く。`status` が `~/Downloads` の候補を見つけると `mv … && chmod 600 …` のコマンドをそのまま返すので、それを実行すればよい。`import_client_secret` ツール（CLI: `drivelift import-secret <path>`）でも同じことができる。パスを省くと候補を列挙するだけで、コピーはしない
6. `auth_start` ツール（CLI: `drivelift login`）でブラウザが開くのでログインする。ツールは同意が終わるまで待つので、終わったことを伝え直す必要はない

以後は `upload` を呼ぶだけ。設定が欠けた状態で `upload` を呼んでも、同じ手順が `next_steps` として返る。

## ツール

| ツール | 役割 |
|--|--|
| `status` | 導入状態（`no_client` / `no_token` / `token_invalid` / `api_disabled` / `ready`）と次の一手、Console の URL |
| `auth_start` | ログイン開始。ブラウザを開き、同意が終わるまで最大 `wait_seconds`（既定 90 秒）待って `completed` を返す。間に合わなければ `pending` |
| `auth_status` | ログインの進捗（`idle` / `pending` / `completed` / `failed`）。`wait_seconds` で決着まで待てる |
| `import_client_secret` | ダウンロード済みのクライアント JSON を設定ディレクトリへ取り込む |
| `gcloud_setup` | gcloud が入っていれば手順 1・2（プロジェクト用意と Drive API 有効化）を代理実行。`confirm` なしは打つコマンドを返すだけで、`confirm: true` で実行。gcloud 未ログインなら `gcloud auth login` も代行（ブラウザが開く） |
| `upload` | ファイルを Drive へ置き、URL を返す |

`upload` の引数:

| 引数 | 内容 |
|--|--|
| `path` | ローカルのファイルパス |
| `name` | Drive 上の名前。省略時はファイル名（変換するときは拡張子を落とす） |
| `folder_id` | 置き先フォルダの ID（フォルダ URL の `/folders/` 以降）。省略時はマイドライブ直下。下記「制約」を参照 |
| `folder_path` | `テスト報告/2026-09` のようなフォルダのパス。`folder_id`（省略時はマイドライブ直下）の下で探し、無ければ作る。再利用されるのは drivelift が作ったフォルダだけ |
| `convert` | `auto`（既定）/ `none` / `spreadsheet` / `document` / `presentation` |
| `share` | アップロードしたファイルに付ける共有設定のリスト。各要素は `role`（`reader` / `commenter` / `writer`）、`type`（`user` / `group` / `domain` / `anyone`）、`target`（user・group はメールアドレス、domain はドメイン名、anyone は不要） |
| `notify` | user・group への共有で Google の通知メールを送るか。既定は送らない |

共有は、利用者が指示したときだけ付ける前提で、ツールの説明にもそう書いてある。`anyone` は「リンクを知っている全員」になり外部公開と同じなので、利用者が明示したときだけ使う。共有の一部が失敗してもアップロードは取り消さず、結果の `shared` に1件ずつ成否を返す。

`auto` の変換先: xlsx・xls・csv・tsv・ods → スプレッドシート、docx・doc・odt・rtf・txt・md・html → ドキュメント、pptx・ppt・odp → スライド。それ以外はそのまま置く。

## CLI

```
drivelift                       MCP stdio サーバーとして起動
drivelift doctor                導入状態と次の一手
drivelift login                 ブラウザでログイン（完了まで待つ）
drivelift import-secret [path]  クライアント JSON の取り込み
drivelift setup-gcloud [--project ID] [--yes]  gcloud で手順 1・2 を実行（--yes なしは計画表示）
drivelift upload <file> [--folder ID] [--folder-path A/B] [--name N] [--convert MODE]
                 [--share ROLE:TYPE[:TARGET]]... [--notify] [--json]
```

`upload` は既定で URL だけを標準出力に出すので、スクリプトから拾いやすい。`--share` は繰り返し指定できる（例: `--share reader:domain:example.com --share writer:user:alice@example.com`）。共有に1件でも失敗すると、URL は出したうえで終了コード 3 を返す。

## 設定

| 場所 | 内容 |
|--|--|
| `~/.config/drivelift/client_secret.json` | Console からダウンロードした JSON（`import-secret` 経由なら 0600。手で置いた場合は自分で権限を絞る） |
| `~/.config/drivelift/token.json` | リフレッシュトークンと access_token のキャッシュ（0600、平文） |
| 環境変数 `DRIVELIFT_CONFIG_DIR` | 設定ディレクトリの変更 |
| 環境変数 `DRIVELIFT_CLIENT_ID` / `DRIVELIFT_CLIENT_SECRET` | ファイルの代わりにクライアントを渡す（`.mcp.json` の `env` 向け） |

## チームで使う場合

代表者が1人で OAuth クライアントを作り、ダウンロードした JSON をメンバーに配る運用ができる。

- **配るのは JSON だけ。** 各メンバーは `import_client_secret`（または `mv`）で取り込み、`auth_start` で**自分のアカウントで**ログインする。トークンは各自の手元にだけあり、代表者の権限で他人が操作することはない
- **Google Workspace なら同意画面は「内部」にする。** 組織外のアカウントは認可できないので、JSON が外に漏れても組織外からは使えない。Google はデスクトップ種別の client_secret を秘密情報として扱わないが、配布はパスワード管理ツールや DM に留め、リポジトリには置かない
- **ファイルは各自のマイドライブに作られる。** 共有したい相手には `share` で権限を付ける（例: 同じ組織の全員に閲覧権限なら `{"role": "reader", "type": "domain", "target": "example.com"}`）
- **共有フォルダに全員で置く運用は、今の権限範囲では難しい見込み。** `drive.file` の権限はユーザーごとに付くため、Aさんの drivelift が作ったフォルダを共有しても、Bさんの drivelift からは見えないと考えている（未検証）。当面は各自のマイドライブに作り、`share` で相手に届けるか、URL を共有の置き場に載せる
- **クライアントを作り直すと全員が `invalid_client` になる。** 新しい JSON を配り直せば、取り込み時に古いトークンを破棄して再ログインに進む
- **プロジェクトの Owner を2人以上にしておく。** 代表者の異動や退職でクライアントを管理できなくなるのを防ぐ
- **Drive API の上限はプロジェクト単位で全員が共有する。** 通常の利用で問題になる量ではない

## 制約と注意

- `drive.file` スコープでは、drivelift が作っていない既存フォルダは drivelift から見えないため、`folder_id` に指定しても Drive が 404 を返す見込み（実機で確認中。結果は docs/design.md に記録する）。現時点では `folder_id` を省略してマイドライブ直下に置き、Drive の画面で移動する運用を前提にしている。フォルダ作成ツールか `drive` スコープの opt-in は、確認結果を見てから決める
- 同名ファイルがあっても上書きせず、新しいファイルを作る（Drive の既定どおり）
- `token.json` は暗号化していない。マシンを共有する環境では `DRIVELIFT_CONFIG_DIR` を保護された場所に向ける
- Google Workspace の管理者がサードパーティアプリの API アクセスを制限している場合、「内部」クライアントでも認可できないことがある

## 開発

```
npm install
npm test
npm run build
```

テストは Google に接続しない（fetch を差し替え、ループバックのログインは実際のポートで検証する）。

## ライセンス

MIT

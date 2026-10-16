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

1. Google Cloud プロジェクトを作る（既存でも可）: https://console.cloud.google.com/projectcreate 。gcloud が入っていれば `gcloud_setup` ツールが手順 1・2 を代理実行する。ツールは打つコマンドを先に見せ、承認を得てから実行する。CLI では `drivelift setup-gcloud` で計画を表示し、`--yes` を付けると実行する。手順 3・4 に gcloud の代替はない
2. Google Drive API を有効化: https://console.cloud.google.com/apis/library/drive.googleapis.com
3. OAuth 同意画面を設定: https://console.cloud.google.com/auth/overview
   - Google Workspace のアカウントなら **内部**（審査不要。テスト状態の7日失効も起きない）
   - 個人 Gmail なら **外部** にして **本番に公開**する。テスト状態のままだとリフレッシュトークンが 7 日で失効する
4. OAuth クライアントを **デスクトップ アプリ** 種別で作り、JSON をダウンロード: https://console.cloud.google.com/auth/clients/create
5. JSON を所定の場所に置く。`status` が `~/Downloads` の候補を見つけると `mv … && chmod 600 …` のコマンドをそのまま返すので、それを実行すればよい。`import_client_secret` ツール（CLI: `drivelift import-secret <path>`）でも同じことができる。パスを省くと候補を列挙するだけで、コピーはしない
6. `auth_start` ツール（CLI: `drivelift login`）でブラウザが開くのでログインする。ツールは同意が終わるまで待つので、終わったことを伝え直す必要はない。複数の Google アカウントを使うときは「[複数の Google アカウント](#複数の-google-アカウント)」を参照

以後は `upload` を呼ぶだけ。設定が欠けた状態で `upload` を呼んでも、同じ手順が `next_steps` として返る。

## ツール

| ツール | 役割 |
|--|--|
| `status` | 導入状態（`no_client` / `no_token` / `token_invalid` / `api_disabled` / `ready`、複数アカウントで使う枠が決まらなければ `account_unresolved`）と次の一手、Console の URL。ログイン済みのアカウントごとの状態（`accounts`）と、作業ディレクトリから解決される枠（`resolved`）も返す |
| `auth_start` | ログイン開始。ブラウザを開き、同意が終わるまで最大 `wait_seconds`（既定 45 秒）待って `completed` を返す。間に合わなければ `pending`。`login_hint` にメールアドレスを渡すと、ログインするアカウントとして Google に伝える |
| `auth_status` | ログインの進捗（`idle` / `pending` / `completed` / `failed`）。`wait_seconds` で決着まで待てる |
| `import_client_secret` | ダウンロード済みのクライアント JSON を設定ディレクトリへ取り込む |
| `gcloud_setup` | gcloud が入っていれば手順 1・2（プロジェクト用意と Drive API 有効化）を代理実行。`confirm` なしは打つコマンドを返すだけで、`confirm: true` で実行。gcloud 未ログインなら `gcloud auth login` も代行（ブラウザが開く） |
| `upload` | ファイルを Drive へ置き、URL を返す |
| `map_source` | 到達元（リポジトリの git remote、または git でないディレクトリの絶対パス）をアカウントに対応づける。`remove: true` で外す。`source` を省くと、`path`（省略時は作業ディレクトリ）の到達元を返すだけで何も書かない |

`upload` の引数:

| 引数 | 内容 |
|--|--|
| `path` | ローカルのファイルパス |
| `name` | Drive 上の名前。省略時はファイル名（変換するときは拡張子を落とす） |
| `folder_id` | 置き先フォルダの ID（フォルダ URL の `/folders/` 以降）。編集できるフォルダなら共有ドライブでも可。省略時はマイドライブ直下 |
| `folder_path` | `テスト報告/2026-09` のようなフォルダのパス。`folder_id`（省略時はマイドライブ直下）の下で探し、無ければ作る。再利用されるのは drivelift が作ったフォルダだけ |
| `convert` | `auto`（既定）/ `none` / `spreadsheet` / `document` / `presentation` |
| `share` | アップロードしたファイルに付ける共有設定のリスト。各要素は `role`（`reader` / `commenter` / `writer`）、`type`（`user` / `group` / `domain` / `anyone`）、`target`（user・group はメールアドレス、domain はドメイン名、anyone は不要） |
| `share_new_folder` | `folder_path` の末端フォルダを今回新しく作ったときだけ、`share` と同じ共有をそのフォルダにも付ける。再利用したフォルダと `folder_id` のフォルダには付けない。`share` と `folder_path` が必要 |
| `notify` | user・group への共有で Google の通知メールを送るか。既定は送らない |
| `replace_id` | 新しく作らず、以前 drivelift で上げたファイル（ID）の中身を差し替える。URL と共有設定はそのまま残る。`folder_id`・`folder_path` とは併用できない |
| `account` | 送るアカウント（ログイン済みのメールアドレス）。省略時は到達元から解決する（「[複数の Google アカウント](#複数の-google-アカウント)」） |

`replace_id` は同じレポートを直して配り直すためのもの。差し替えは中身の全置き換えで、Sheets 上で直接加えた編集やコメントは消える（以前の版は Drive の版の履歴に残る）。シートの内部 ID も変わるので、特定のタブを指すリンク（`#gid=`）は切れる。取り違えを防ぐため、差し替え先がゴミ箱にあるとき、今回のアップロード名と名前が違うとき、種類が違うとき（スプレッドシートにドキュメントを上げる等）は、送信せずに拒否する。drive.file の範囲なので、drivelift が作っていないファイルは差し替えられない。

共有は、利用者が指示したときだけ付ける前提で、ツールの説明にもそう書いてある。`anyone` は「リンクを知っている全員」になり外部公開と同じなので、利用者が明示したときだけ使う。共有の一部が失敗してもアップロードは取り消さず、結果の `shared` に1件ずつ成否を返す。

`share_new_folder` は、PR ごと・日付ごとのフォルダをチームに URL で渡すためのもの。フォルダへの共有の成否は `folder_shared` に返る（付けなかったときは空）。共有するのは末端のフォルダ（結果の `folder_id`）だけで、途中の階層を新しく作っていてもそこには付けない。フォルダの共有は中身に継承されるので、**そのフォルダに後から置いたファイルも同じ相手に見える**。再利用したフォルダに付けないのは、以前置いたファイルまで見えるようになるのを防ぐため。そのため、この機能より前に作ったフォルダや、作成時に共有が失敗したフォルダは、次回以降も共有されない。必要なら Drive の画面で手動で共有する。

`auto` の変換先: xlsx・xlsm・xls・ods・csv・tsv → スプレッドシート、docx・doc・odt・rtf・txt・md・html・htm → ドキュメント、pptx・ppt・odp → スライド。それ以外はそのまま置く。変換は Drive のインポート機能が行う。実機で確認したのは xlsx・csv（スプレッドシート）と md（見出しや表を解釈したドキュメント）で、ほかは Drive の対応形式に従う。

## CLI

```
drivelift                       MCP stdio サーバーとして起動
drivelift doctor                導入状態と次の一手、ログイン済みのアカウントと解決される枠
drivelift login [--hint EMAIL]  ブラウザでログイン（完了まで待つ）
drivelift import-secret [path]  クライアント JSON の取り込み
drivelift setup-gcloud [--project ID] [--yes]  gcloud で手順 1・2 を実行（--yes なしは計画表示）
drivelift upload <file> [--account EMAIL] [--folder ID] [--folder-path A/B] [--name N] [--convert MODE]
                 [--share ROLE:TYPE[:TARGET]]... [--share-new-folder] [--notify] [--replace ID] [--json]
drivelift map <email> [source] [--remove]  到達元をアカウントに対応づける（source を省くと作業ディレクトリの到達元を表示するだけ）
```

`upload` は既定で URL だけを標準出力に出すので、スクリプトから拾いやすい。`--share` は繰り返し指定できる（例: `--share reader:domain:example.com --share writer:user:alice@example.com`）。共有に1件でも失敗すると（`--share-new-folder` によるフォルダの共有を含む）、URL は出したうえで終了コード 3 を返す。`--share-new-folder` を付けたのにフォルダが既存だった場合は、共有しなかったことを標準エラーに出す（終了コードは 0）。アカウントが決まらずに拒否したときは終了コード 2。`--account` で送ったとき、到達元の git リポジトリがどのアカウントにも対応づいていなければ、対応づける `drivelift map` のコマンドを標準エラーに出す。到達元が別のアカウントに対応づいていれば、そのことを標準エラーに出す（送信はする）。

## 設定

| 場所 | 内容 |
|--|--|
| `~/.config/drivelift/client_secret.json` | 次のログインに使うクライアント。Console からダウンロードした JSON（`import-secret` 経由なら 0600。手で置いた場合は自分で権限を絞る） |
| `~/.config/drivelift/accounts/<email>/client_secret.json` | そのアカウントのログインに使ったクライアントの写し（0600）。refresh に使う。環境変数のクライアントでログインした場合は作らず、refresh も環境変数のクライアントで行う |
| `~/.config/drivelift/accounts/<email>/token.json` | リフレッシュトークンと access_token のキャッシュ（0600、平文） |
| `~/.config/drivelift/accounts/<email>/sources.json` | そのアカウントに対応づけた到達元の配列 |
| `~/.config/drivelift/legacy-migration.json` | 0.4.0 の `token.json` を写した・写せなかった記録（その内容のハッシュと結果） |
| 環境変数 `DRIVELIFT_CONFIG_DIR` | 設定ディレクトリの変更 |
| 環境変数 `DRIVELIFT_CLIENT_ID` / `DRIVELIFT_CLIENT_SECRET` | ファイルの代わりにクライアントを渡す（`.mcp.json` の `env` 向け） |
| 環境変数 `DRIVELIFT_ACCOUNT` | `upload` に使うアカウント（`.mcp.json` の `env` 向け） |

アカウントの枠は、ログインしたときに about.get で取れたメールアドレスの名前で作られる。メールアドレスが取れなければ（Drive API が有効になっていない等）、ログインは失敗し、何も保存しない。Drive API を有効にしてからログインし直す。

### 0.4.0 からの移行

0.4.0 までは `~/.config/drivelift/token.json` の 1 枠だけだった。0.5.0 以降はこのファイルを読まず、最初に `status`・`upload`・`map_source`（CLI では `doctor`・`upload`・`map`）を呼んだときに、そのアカウントの枠へ写す。写す前に今のクライアントで 1 回 refresh し、通ることを確かめる。通らなければ写さず、理由（`invalid_grant`、`invalid_client`、通信の失敗）を返す。ログイン済みのアカウントが 1 つも無い状態では、3 つのツールのどれを呼んでもこの理由が返る。ファイルが壊れていれば、ログインし直すよう案内する。

写した結果は、`token.json` の内容のハッシュと一緒に `legacy-migration.json` に残す。内容が同じ間は写し直さない。Google が拒否した（`invalid_grant`、`invalid_client`）場合も、ファイルが変わるまで再試行せず、`status` に理由と消し方を出し続ける。通信の失敗は記録せず、次の呼び出しで再試行する。0.4.0 側でログインし直すなどで `token.json` が変われば写し直すが、同じアカウントの枠が既にあればその枠には触れない（0.5.0 でログインし直した枠を、古いトークンで戻さないため）。

トップレベルの `client_secret.json` を差し替えてもログイン済みのアカウントは消えない。各枠が自分のクライアントの写しで refresh を続ける。

元の `token.json` は消さない。動いている 0.4.0 のプロセスや、0.4.0 を使う別の設定は、元のファイルをそのまま使い続けられる。0.5.0 以降だけを使うなら `rm ~/.config/drivelift/token.json` で消してよく、`status` もそう案内する。

## 複数の Google アカウント

案件ごとに Google アカウントを分けている場合は、アカウントごとにログインし、作業リポジトリ（到達元）をアカウントに対応づける。1 つのアカウントに複数の到達元を対応づけられる。

```
drivelift login --hint a@client-a.example
drivelift login --hint me@gmail.com
cd ~/work/client-a-repo && drivelift map a@client-a.example
```

`map` は source を省くと、作業ディレクトリの到達元（例: `github.com/client-a/repo`）を表示するだけで何も書かない。表示を確かめてから `drivelift map a@client-a.example github.com/client-a/repo` で対応づける。ツールでは `map_source` が同じ働きをする。

到達元は、git の作業ツリーなら remote `origin` の URL を正規化したもの（`https://`・`git@host:`・port・`.git`・末尾の `/` の違いを吸収した `github.com/org/repo`）で表す。clone 先や worktree が変わっても同じ到達元になる。origin の無い git は git ルートの絶対パス、git でないディレクトリは絶対パスで表し、対応づけた絶対パスの配下にも当たる。

- **パスの対応づけは、origin のある git の作業ツリーの中には当たらない。** その中の到達元は remote になるため。リポジトリは remote で対応づける
- **パスの対応づけが重なるときは、長い方が勝つ（最長一致）。** `/work` を A、`/work/clientB` を B に対応づけると、`/work/clientB/x` は B、それ以外の `/work` の下は A になる
- **ルート（`/`）・ホームディレクトリ・一時ディレクトリ（`/tmp`・`/var/tmp` を含む）と、それらの親は対応づけられない。** 前方一致でほぼ全ファイルが当たるため。ホームを丸ごと git で管理している（dotfiles）場合、その remote も同じ理由で `suggest_map` に出さず、`map` の候補でも対応づけられないと返す。remote を source に明示したときは、作業ディレクトリの git がその remote を指している場合に限り拒否する（それ以外は作業ツリーの広さを知りようがない）
- **git remote は host 付きで渡す**（`github.com/owner/repo`、または clone の URL）。`owner/repo` だけでは受け付けない。ドットの無い host（社内の git サーバー等）は clone の URL（`git@gitserver:org/repo`・`https://gitserver/org/repo`）で渡す
- **remote は全体を小文字に揃える。パスは realpath で実際の綴りに揃える。** シンボリックリンクは実体になり、大文字小文字を区別しないファイルシステム（macOS の既定）ではディスク上の綴りになる。存在しないパスは対応づけられない（外すことはできる）
- **git が読めないときは、到達元が分からないものとして扱う。** git が入っていない場合や、所有者の違うリポジトリ（dubious ownership）の場合。パスの対応づけには落とさず、アカウントが 2 つ以上あれば拒否する。理由は `status` の `resolved.reason` と拒否の応答に入る

`upload` は次の順でアカウントを決める。

1. 引数 `account`（CLI: `--account`）
2. 環境変数 `DRIVELIFT_ACCOUNT`。プロジェクトの `.mcp.json` の `env` に置けば、そのプロジェクトからは常にそのアカウントを使う
3. アップロードするファイルの到達元を、各アカウントの `sources.json` で引く
4. ログイン済みのアカウントが 1 つならそれ
5. どれにも当たらずアカウントが 2 つ以上あれば、**何も送らずに拒否する**。応答に選べるアカウントの一覧（`candidates`）と到達元（`source`）が入るので、どのアカウントで送るかを利用者が決める

同じ到達元が 2 つのアカウントに対応づいている場合（`sources.json` を手で書いた等）も、5 と同じく拒否する。結果の `account` は使ったアカウント、`source` は解決に使った到達元（引数・環境変数・唯一のアカウントで決まったときは `null`）。

対応づけは自動では書かない。`account` を付けて上げたとき、到達元の git リポジトリがどのアカウントにも対応づいていなければ、結果に `suggest_map`（`source` と `account`）が入る。エージェントはこれを見て、利用者に対応づけを申し出る。`map_source` は利用者が承認したときだけ呼ぶ前提で、ツールの説明にもそう書いてある。

パスの到達元（git でないディレクトリ、origin の無い git）では `suggest_map` を出さない。パスの対応づけは配下のファイルすべてに効くので、エージェントの提案からではなく、利用者が `map_source`（`map`）で明示したときだけ作る。

`account` で指定したアカウントが、到達元に対応づいているアカウントと違っても、指定どおりに送る。そのとき結果に `mapped_to`（対応づいているアカウント）が入るので、エージェントは意図したアカウントかを利用者に確かめる。

別のアカウントに対応づいている到達元は、`map_source` で追加できない。付け替えるには、先に元のアカウントから `remove: true` で外し、それから追加する。2 回に分けてあるのは、注入された 1 回の呼び出しで送り先を恒久的に変えられないようにするため。

同じアカウントでログインし直すと、そのアカウントの枠だけが差し替わる。ログインは認可 URL に `prompt=select_account` を付けるので、必ずアカウント選択画面を経る（黙って前のアカウントを使わない）。`login_hint` を付けると、選択画面にはそのアカウントが提示される（2026-10-16 実機。別のアカウントが並ぶかはブラウザのセッション次第）。アカウントを消すには、その枠のディレクトリ（`~/.config/drivelift/accounts/<email>`）を削除する。削除用のツールは用意していない。

## チームで使う場合

代表者が1人で OAuth クライアントを作り、ダウンロードした JSON をメンバーに配る運用ができる。

- **配るのは JSON だけ。** 各メンバーは `import_client_secret`（または `mv`）で取り込み、`auth_start` で**自分のアカウントで**ログインする。トークンは各自の手元にだけあり、代表者の権限で他人が操作することはない
- **Google Workspace なら同意画面は「内部」にする。** 組織外のアカウントは認可できないので、JSON が外に漏れても組織外からは使えない。Google はデスクトップ種別の client_secret を秘密情報として扱わないが、配布はパスワード管理ツールや DM に留め、リポジトリには置かない
- **ファイルは各自のマイドライブに作られる。** 共有したい相手には `share` で権限を付ける（例: 同じ組織の全員に閲覧権限なら `{"role": "reader", "type": "domain", "target": "example.com"}`）
- **チームの共有フォルダ（共有ドライブを含む）に置ける。** フォルダの ID を `folder_id` に渡せば、各自の drivelift がそこへ直接作る。ただし `folder_path` のサブフォルダはメンバーごとに別々に作られる（Aさんの drivelift が作ったフォルダは、Bさんの drivelift からは見えないため）。全員で同じ場所に集めたいときは、サブフォルダを手で作ってその ID を配り、`folder_id` で指定する
- **新しく作ったフォルダの URL を渡すなら `share_new_folder` を付ける。** 付けないと、共有されるのはファイルだけで、フォルダは作った本人しか開けない
- **クライアントを作り直すと全員が `invalid_client` になる。** 新しい JSON を配り直し、各自が取り込んで `auth_start` でログインし直すと、その枠のクライアントとトークンが差し替わる
- **プロジェクトの Owner を2人以上にしておく。** 代表者の異動や退職でクライアントを管理できなくなるのを防ぐ
- **Drive API の上限はプロジェクト単位で全員が共有する。** 通常の利用で問題になる量ではない

## 制約と注意

- **`upload` を常時許可すると、共有も常時許可したことになる。** `share` を使えば、1回の呼び出しで任意の外部アドレスやドメインに権限を付けられる（0.2.0 から）。ホストのツール許可で upload を「常に許可」にしている場合、プロンプトインジェクションでファイルを外部に共有される余地がある。0.1.0 で常に許可した人も、`drivelift@0` を指定していれば自動で新しい版（0.2.0 以降。0.3.0 からは差し替え `replace_id`、0.4.0 からはフォルダ共有 `share_new_folder` も）に上がる。`upload` は MCP の注釈で破壊的操作（`destructiveHint: true`）と宣言している。気になる場合は upload を毎回確認する設定にする。`share_new_folder` も同じ扱いで、新しく作ったフォルダに限られるが、共有は以後そのフォルダに置くファイルにも及ぶ

- `folder_id` には、ログインしたアカウントが編集できるフォルダなら何でも指定できる。drivelift が作っていないフォルダや共有ドライブ内のフォルダでもよい（2026-09-25 に共有ドライブで確認）。ただし drive.file の権限では、そのフォルダの中身は見えない。そのため `folder_path` で再利用できるのは drivelift が作ったフォルダだけで、他の人や手で作った同名フォルダがあっても、別に同名のフォルダを作る
- 同名ファイルがあっても上書きせず、新しいファイルを作る（Drive の既定どおり）。上書きは `replace_id` で ID を明示したときだけ
- `upload` を常時許可していると、プロンプトインジェクションで drivelift が作ったファイルを別の中身に差し替えられる余地がある（`replace_id`、0.3.0 から）。drivelift が作ったもの以外には届かず、以前の版は版の履歴から戻せる
- **`map_source` と `upload` の `account` は、注入で送り先のアカウントを変えられる。** `map_source` の対応づけは、以後その到達元からの `upload` すべてに効く。付け替えは外す・追加するの 2 回に分けてあるが、`map_source` を常時許可していれば、どちらも確認なしで通る。`upload` を常時許可していれば、`account` 引数で別のアカウントへ送らせることもできる（到達元の対応づけと食い違えば、結果の `mapped_to` で分かる）。`map_source` は毎回確認する設定にしておく
- ログイン済みのアカウントが 1 つのときは、対応づけが無くても従来どおり黙ってそのアカウントで送る。別案件のアカウントでしかログインしていなければ、そのアカウントに置かれる。2 つ目のアカウントでログインした時点で、対応づけの無い到達元からの `upload` は拒否されるようになる
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

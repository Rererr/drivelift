# drivelift 設計メモ

作成 2026-09-24。発端は pacenote の Tech/Product テスト責務分担で、開発側の動作確認レポート（xlsx）を書式を保ったまま Google スプレッドシートとしてプロダクト側へ渡す経路が要ったこと。MCP の Drive コネクタは base64 経由で 3 回中 2 回壊れ、rclone は導入と共有クライアントの扱いが重かった。同じ壁は LLM エージェントを使う人全員に共通なので、社内スクリプトではなく公開ツールにした。

## 目的と非目標

目的は 1 つ。ローカルのファイルを Drive にネイティブ形式で置き、URL を返す。

やらないこと:

- Drive の閲覧・検索・ダウンロード・削除（Drive MCP の領分。drivelift は書く方向だけ。例外は `folder_path` の再利用のための、自分が作ったフォルダの検索だけ）
- 共有クライアントの同梱（rclone 型）。`gdrive` CLI が共有クライアントを Google に止められた前例があり、公開者が他人の認可の責任を負う形は取らない
- 同意画面と OAuth クライアント作成の代行。API がなく Console が唯一の経路なので、誘導は URL の提示で止める。プロジェクト作成と API 有効化だけは gcloud があれば代理実行する（`gcloud_setup`。計画表示 → confirm の2段で、実行前に必ず内容を見せる）
- ホスティング。リモート MCP にすると他人のリフレッシュトークンを預かることになる

## 構成

```
cli.ts ──┐
         ├── core.ts ── oauth.ts ── config.ts
server.ts┘      │          │
                ├── drive.ts (REST, fetch)
                ├── source.ts (到達元の鍵・アカウント解決, git)
                └── status.ts (状態→次の一手)
```

MCP サーバーと CLI は同じハンドラ（core.ts）を使う。外部依存（設定ディレクトリ・fetch・時計・ブラウザ起動・cwd・git）は `Deps` で注入し、テストは Google に接続しない。

## 状態機械

導入状態は 5 つ。どの状態でも同じ形（state / message / next_steps / urls）で返す。0.5.0 からは枠（アカウント）ごとに 5 つのどれかを持ち、トップレベルにだけ 6 つ目の account_unresolved がある。

| 状態 | 検出 | 次の一手 |
|--|--|--|
| no_client | client_secret.json も環境変数もない（枠ごとには、その枠のクライアントの写し、または env でログインした枠の環境変数がない） | Console の 4 リンクと保存先パス |
| no_token | ログイン済みの枠（`accounts/<email>/token.json`）が 1 つもなく、0.4.0 の token.json も無いか、壊れていて写せない | auth_start |
| token_invalid | refresh が invalid_grant | auth_start。7 日周期なら同意画面の公開状態を疑う |
| api_disabled | Drive API が 403 accessNotConfigured | 応答に含まれる有効化 URL |
| ready | about.get が通る | upload |
| account_unresolved | 枠が 2 つ以上あり、cwd の到達元がどの枠にも対応づいていない・2 つの枠に対応づいている・git が読めない。または DRIVELIFT_ACCOUNT が未ログインのメール | 利用者にアカウントを選ばせ、upload の account か map_source |

`upload` は `status` を先に呼ばなくても、欠けている状態の Status を伴って失敗する。利用者はいきなり使って誘導される。

## 決定と理由

1. **BYO クライアント。** 利用者はエンジニアか LLM 慣れした人で、GCP でクライアントを作ることに困らない前提。誘導があれば十分
2. **`drive.file` のみ。** 非機密スコープで、外部アプリでもセキュリティ審査が不要。見知らぬ人に認可してもらう上での信頼の根拠でもある
3. **secret はパス経由。** LLM のコンテキストに secret を通さない。`~/Downloads` の候補列挙まではするが、コピーは明示のパス指定でしか行わない
4. **ログインは待ち受け付きの 2 段。** auth_start はブラウザでの同意を既定 45 秒待ち、終われば completed を返す。45 秒にしているのは、多くの MCP クライアントのリクエスト既定タイムアウト（公式 SDK は 60 秒）に収めるため。間に合わなければ pending を返し、auth_status の wait_seconds で待ち直す。CLI の login は完了まで待つ
5. **Desktop 種別のクライアントに限定。** ループバックの動的ポートを redirect_uri 登録なしで使えるのは Desktop 種別だけ。Web 種別の JSON は取り込み時に弾いて作り直しを案内する
6. **resumable upload。** メタデータ POST → セッション URL へ PUT の 2 段。変換先 mimeType と親フォルダをメタデータに載せるだけで済み、本体は Content-Type だけ付けて送れる。現状は本体をメモリに載せて 1 回の PUT で送っており、再開もストリーム化もしていない（数百 MB を超える成果物が要件に入ったときに足す）
7. **名前では上書きしない。ID を明示したときだけ差し替える。** 名前で同一性を判断すると、Drive は同名ファイルを複数持てるため重複や取り違えが起きる（rclone が `dedupe` を持つ理由）。0.3.0 で `replace_id` を足した。files.update に変換付きで media を送ると中身が全置き換えになり、ID・URL・共有は保たれる（Drive API の公式ガイドに明記、2026-09-25 実測）。取り違え対策として、差し替え先がゴミ箱にある・名前が今回のアップロード名と違う・種類が違う場合は送信前に拒否する。名前の照合は、ID を控えた文書をコピーして別の文書を作ったときに旧文書を上書きしないためのもの。差し替えは書く方向の操作なので「読まない・消さない」の線は保つ

## セキュリティ上の性質

- `upload` は読めるローカルファイルなら何でも送れる。行き先は既定ではマイドライブだが、`folder_id` には利用者が編集できる任意のフォルダを指定できる（drive.file でも可、2026-09-25 実測）。攻撃者が自分のフォルダを利用者に編集権限で共有しておき、プロンプトインジェクションでその ID を `folder_id` に渡させれば、ファイルを攻撃者の手元に置ける。drivelift からは正規のチームフォルダと区別できないので、実装では塞げない。対策はツール説明で「folder_id は利用者が指定したものだけを使う」と明示することと、ホスト側の許可プロンプトで upload の引数を確認させることに置く。
- `share`（0.2.0 で追加）は、upload と同じ1回の呼び出しで、任意の外部アドレス（user/group）・任意のドメイン・anyone に権限を付けられる。folder_id の経路と違い、攻撃者側の事前準備が要らない。0.1.0 までの「流出させるには共有という別の手順が要る」という性質は、0.2.0 で無くなった。対策はツール説明（共有先は利用者が名指しした相手だけ、ファイルの中身や Web ページから取らない、anyone は明示されたときだけ）と、ホスト側の許可プロンプトだけ。upload を常時許可している利用者は、共有も常時許可していることになる。README の導入例は `drivelift@0` なので、0.1.0 で常時許可した利用者にも自動で届く点を README の「制約と注意」に書く
- 1回の share は最大 20 件（通知メールの大量送信を防ぐ）
- `replace_id`（0.3.0）で、drivelift が作ったファイルの中身を任意の内容に差し替えられる。drive.file なので他人のファイルや drivelift 以外で作ったファイルには届かず（drivelift が作っていないフォルダの ID で 404 を実測。他アプリが作ったファイルは仕様上 404 のはず）、以前の版は版の履歴から戻せる。流出ではなく改ざんの経路で、影響は share より小さい。対策は同じくツール説明（ID は自分の過去のアップロードか利用者が渡したものだけ）とホストの許可プロンプト
- `share_new_folder`（0.4.0）は `share` と同じ相手を、今回作った末端フォルダにも付ける。フォルダの共有は中身に継承されるので、以後そのフォルダに置くファイルにも及ぶ（ファイル単位の share より効果が長く続く）。そのため既定では付けず、明示したときだけにする。再利用したフォルダには付けない。以前置いたファイルが中に入っていると、それらまで公開してしまうため。新規のフォルダなら、中身は今回のファイルだけで、そのファイルにも同じ共有を付けるので、公開範囲は広がらない（逐次の呼び出しの場合。同じフォルダへ並行でアップロードすると、作らなかった側のファイルも作った側の共有を継承する。その側の `folder_shared` は空になる）。判定は「末端を自分が作ったか」で行う。途中の階層を作ったかどうかでは判定しない。別プロセスが同時に末端を作ると、途中だけ作って末端は再利用、という状態がありうるため。`notify` はフォルダにも適用するので、user/group の相手には通知が2通届く（1回の呼び出しで権限を作るのは最大 40 件）途中の階層は、新しく作っていても共有しない（親に付けると、同じ親の下に後から共有なしで置いたものまで見えてしまう）
- ループバックの待ち受けは state を最初に照合し、state の無いリクエストは成功にも失敗にも進めない。他サイトからのポート総当たりでログインを妨害できない
- 応答 HTML に埋める外部由来の値（Google の error 値・エラーメッセージ）はエスケープする
- code 交換中の重複コールバックは 409 で無視し、二重交換しない
- stdio 切断時は待ち受け中のログインを閉じ、ポートを握った孤児プロセスを残さない

## 実アカウントで確認済み（2026-09-25、Google Workspace・内部クライアント）

- パス付きの redirect_uri（`127.0.0.1:<port>/callback`）で Desktop クライアントのループバックが通る
- resumable セッション URL への PUT（Authorization 付き）で xlsx が Google スプレッドシートに変換される
- 変換後も列幅・塗り・タブが保たれ、埋め込み画像は解像度（1400px）を保ったまま残る
- 別のクライアント JSON を取り込むと旧トークンを破棄し、`no_token` から再ログインに進む（0.5.0 で挙動変更: 取り込んでもログイン済みの枠は消さない。各枠はクライアントの写しで refresh を続ける）
- `gcloud_setup` の計画表示と実行（プロジェクト作成・Drive API 有効化）

注意: Sheets は xlsx の行高（pt）を px として取り込み、Hyperlink に display が無いと表示文字を `#gid=…` に置き換える。どちらも drivelift ではなく xlsx を作る側で対処する事柄なので、README には書かず利用側（pacenote の test-report.py）に記録した。

- drivelift が作っていない既存フォルダ（共有ドライブ内）を `folder_id` に指定しても、その中にファイルとフォルダを作れる。フォルダ自体の読み取りは 404 になる（drive.file は作成の親にだけ ID で書き込める）
- `share` で domain に閲覧権限を付けられる（`allowFileDiscovery: false` ＝リンクを知っている組織内の人だけ）
- `folder_path` のフォルダは2回目に再利用される。マイドライブ直下（既定の corpora）と共有ドライブ内のフォルダの下（`corpora=allDrives`）の両方で確認。並べ替えは API の orderBy を使わず、全ページを取って手元で最古を選ぶ。検索が欠けた（incompleteSearch）うえで1件も無いときは、重複を避けるため作らずに止める
- md → Docs は Markdown として解釈される（見出し・表になる）
- `replace_id` での差し替え（2026-09-25）: ID・URL が変わらず、中身（本文・画像シートの画像・シート間リンク）が新しい版になり、domain の閲覧権限が残る。ゴミ箱のファイル・名前違い・drivelift が作っていないフォルダの ID は送信前に拒否される。他アプリが作ったファイルの ID と種類違いの拒否は実測していない（前者は drive.file の仕様で 404 になるはず、後者はユニットテストのみ）。名前は NFC に正規化して比べる。MCP の注釈は `destructiveHint: true` にした
- `share_new_folder`（2026-09-28、マイドライブ内の既存フォルダの下）: 新しく作った末端フォルダに domain の閲覧権限が付き、組織内の別アカウントがフォルダの URL から中のファイルを開ける。組織外の個人アカウントでは権限なしの画面になる。同じパスで2回目を実行すると再利用になり、共有しない旨を stderr に出して終了コード 0

## 未検証（実アカウントで確かめる）

2. resumable セッション URL への PUT に Authorization が要るか（付けた状態では通る。外した場合は未確認）
4. Console の URL（`auth/overview`・`auth/clients/create`）は新 UI のもの。旧 UI に戻された場合は status.ts の 1 テーブルを直す
6. `xlsm` → Sheets ほか、xlsx・csv・md 以外の変換（`about.importFormats` で確認できる）
7. Windows での PowerShell 経由のブラウザ起動、Linux の xdg-open
8. `share_new_folder` で共有ドライブ内のフォルダに domain 権限を付けられるか（マイドライブでは確認済み）

## 今後

- `drive` スコープの opt-in は不要になった（既存フォルダ・共有ドライブへの書き込みは drive.file で通る）。なお `folder_id` に他人が共有したフォルダを指定すると、そこへファイルを置けること自体は drive.file でも同じなので、description では「利用者が指定した置き先にだけ置く」前提を崩さない
- pacenote の `/test-report` スキルを rclone 経由から `drivelift upload` に差し替える
- npm 公開（`drivelift@0`。利用者側は `npx -y drivelift@0` でメジャー固定）

## 複数アカウント（0.5.0、2026-10-16。承認済み・実装済み）

発端: 個人事業主や複数案件を受けている人は Google アカウントを案件ごとに持つ。0.4.0 までは token.json が 1 枠で、auth_start は前のアカウントを黙って上書きする（prompt=consent のみで select_account も login_hint も付けない）。案件 B でログインし直した後に案件 A のレポートを `folder_id` なしで上げると B のマイドライブに置かれ、`share` が付いていれば B の関係者に A の資料が渡る。クライアント間の漏えい経路で、現状はホストの許可プロンプトで人が `account` を目視するしか防げない。

### 決定

8. **アカウントごとにトークンを持ち、送り元（作業リポジトリ）からアカウントを引く。** 認証情報が到達先、リポジトリが到達元。1 つの到達先に複数の到達元を対応づける。

### 保存

```
~/.config/drivelift/
  client_secret.json            次のログインに使うクライアント（従来どおり import_client_secret の置き先）
  legacy-migration.json         0.4.0 の token.json を写した・写せなかった印（決定 9・10）
  accounts/<email>/
    client_secret.json          そのアカウントのログインに使ったクライアントの写し（refresh に要る）
    token.json                  refresh_token / access_token（0600）
    sources.json                このアカウントに対応づけた到達元の配列
```

- ディレクトリ名はログイン後に about.get で取れたメールアドレス。ログインで初めて枠ができる（事前に名前を決めさせない）。メールアドレスが取れなければ（Drive API 未有効等）保存先が決まらないので、ログインは失敗扱いにして何も保存しない
- 同じメールで再ログインしたら token.json と client_secret.json の写しを差し替える（それ以外の枠には触らない）
- 従来の `token.json`（トップレベル）が残っていれば、`token.account` のメール（無ければ about.get で取ったメール）の枠へ写す（決定 9・10）
- トップレベルの client_secret.json を差し替えてもトークンは消さない（各枠が写しを持つので refresh は従来のクライアントで続く。Console でクライアントを消した枠は refresh で invalid_client になり、その枠だけ token_invalid）
- 削除はディレクトリを消すだけ。削除用ツールは作らない（消し間違いの経路を増やさない。CLI で `rm -r` の案内を出す）

### 到達元の表し方

`sources.json` の各要素は文字列 1 つ。

- 絶対パス（`/` 始まり、Windows は `X:\` / `X:/` 始まりと UNC の `\\server\share\…` / `//server/share/…`）: 前方一致（git でないディレクトリ・origin の無い git 用）。重なれば最長一致（決定 13）
- それ以外: git remote `origin` の URL を正規化したもの。`github.com/org/repo`（scheme・ユーザー名・port・`.git`・末尾 `/` を落とし、パス部分の `//` を `/` に畳み、`git@host:path` は `host/path` に直す）。clone 先や worktree が変わっても同じ鍵で引ける
- remote は全体を小文字に揃える。パスは realpath で実際の綴りに揃える（`fs.realpathSync.native`。シンボリックリンクは実体に、大小を区別しないファイルシステムではディスク上の綴りになる。存在しないパスは `//`・`.`・`..` を畳むだけ）

### 解決順（upload）

1. 引数 `account`（メール）
2. 環境変数 `DRIVELIFT_ACCOUNT`（`.mcp.json` の env に置く用途）
3. `path` のファイルから上へ辿って git ルートを探し、`origin` の正規化 URL で `sources.json` を引く。git でなければ絶対パスの前方一致。鍵は 1・2 で決まらなかったときだけ求める。git が読めなければ鍵は取得失敗（決定 12）
4. 枠が 1 つしか無ければそれ（0.4.0 までと同じ振る舞い。移行直後に手が止まらない）
5. どれにも当たらず枠が 2 つ以上 → 送らずに拒否。応答に `candidates`（メール一覧。status の `accounts` と区別するため別名）と到達元の鍵（`source`）を含め、「どのアカウントで送るか利用者に確認し、`account` を付けて再実行するか `map_source` で対応づける」を next に書く

複数の枠が同じ到達元を持っていたら 5 と同じ扱い（曖昧として拒否）。

黙って選ぶのは 4 だけで、これは今と同じ状態。漏えい経路は「枠が 1 つで、それが別案件のアカウント」に限られ、2 枠以上になった時点で自動的に塞がる。

### ツールと CLI の変更

| 対象 | 変更 |
|--|--|
| `status` / `doctor` | `accounts[]`（email・状態・sources・client の出どころ）と、`cwd` から解決したときに使われる枠 `resolved`（無ければ理由）。トップレベルの `state` は resolved の状態 |
| `auth_start` / `login` | 任意の `login_hint`（メール）。認可 URL に `login_hint` を付け、`prompt=select_account consent` にする（枠の追加なのでブラウザに複数セッションがあれば選ばせる）。完了応答は従来どおり `account` |
| `upload` | 任意の `account`。結果に `account`（従来）と `source`（解決に使った鍵。無ければ null）を返す。`account` が到達元の対応づけと食い違えば `mapped_to`。曖昧で拒否したときは上記 5 |
| `map_source` / `map` | `account` と `source` を受けて `sources.json` に追加・削除。別の枠に対応づいている到達元・広すぎるパス・host の無い `owner/repo` は追加を拒否する。`source` 省略時は `cwd`（CLI）または指定 `path`（ツール）から鍵を求めて候補として返し、書かない（`import_client_secret` のパス省略と同じ「列挙だけ」の形）。注釈は `readOnlyHint: false` |

自動で対応づけない。`account` 引数付きで上げたとき、その到達元（git remote の鍵に限る。決定 11）が未登録なら結果に `suggest_map: { source, account }` を返す。エージェントはそれを見て利用者に「このリポジトリをこのアカウントに対応づけるか」を申し出、Y なら `map_source` を呼ぶ。この機能が防ぎたいのは枠どうしの取り違え（案件 A の資料が案件 B のアカウントに置かれる）なので、対応づけの付け替えは remove → add の 2 段にし、利用者の承認を各段で挟む（決定 14）。

### やらないこと

- 到達元ごとの既定 `folder_id`。置き先はツールの呼び出し側（スキル・スクリプト）が持つ。入れるなら別の決定として扱う
- プロファイル名の自由設定。メールをそのまま名前にする
- アカウントの削除ツール

### 実装時の決定（2026-10-16、コードレビューの指摘に対応）

9. **0.4.0 の token.json は移さず写す。** 写した後も元のファイルは残す。動いている 0.4.0 のプロセスや、0.4.0 を使う別の設定を壊さないため。写した・写せなかった結果は、設定ディレクトリ直下の `legacy-migration.json` に `{ sha256: 旧 token.json の内容のハッシュ, outcome: "migrated" | "failed", email?, reason?, at }` として残し、入口では印のハッシュが今の token.json と一致すれば写し直さない（migrated なら読まない、failed なら理由と「`rm …/token.json` で消せる」を status の message に載せる）。refresh_token の一致で判定していた版は、同じアカウントで先にログインし直した場合・refresh で refresh_token がローテーションされた場合・失効していて他の枠がある場合に、入口のたびに refresh していた。ハッシュが違えば（0.4.0 側でログインし直した・0.4.0 が access_token を更新した等）写し直す。同じアカウントの枠が既にあれば、その枠は上書きしない（0.5.0 でログインし直した枠を古いトークンで戻さない。上書きしないので refresh もしない）。写す時機は起動時ではなく、枠を見る各ツールの入口（status / upload / map_source）。auth_start では写さない（写してからログインしても、ログインしてから写しても結果が同じ）。消すかは利用者が決める。status は写し済みのとき「0.5.0 以降だけを使うなら `rm …/token.json` で消せる」と案内する。ログインし直しても消さない（実装途中にあった「再ログインで旧トークンを消す」処理は廃止）
10. **写す前に 1 回 refresh し、今のクライアントで通ることを確かめる。** `account` フィールドの有無によらない。通らなければ写さず、理由を返す。refresh・about.get の拒否はその状態（invalid_grant・invalid_client なら token_invalid、Drive API 未有効なら api_disabled）、通信の失敗は状態が分からないので Status にせず失敗として返す（no_token と報告すると、要らない再ログインに誘導する）。印を書くのは Google が拒否した invalid_grant・invalid_client のときだけで、通信の失敗・about.get の失敗では書かず次の呼び出しで再試行する。枠が 1 つも無ければ status / upload / map_source のどれも、この理由で返す（map_source が「ログインしていない」と返すと、移行の失敗が見えない）。ほかに枠があれば status は落とさず、理由を message に載せる
11. **suggest_map は git remote の鍵のときだけ返す。** パスの対応づけは前方一致で配下すべてに効くので、利用者が map_source / map で明示したときだけ作る。map_source は `/`・ホームディレクトリ・一時ディレクトリ（`os.tmpdir()` と `/tmp`・`/var/tmp`、と、その実体パス）と、それらの祖先を拒否する。前方一致でほぼ全ファイルが当たるため。git remote でも、作業ツリーがそれらに当たる（ホームを丸ごと git で管理している等）なら suggest_map を出さず、map_source の候補も「対応づけられない」と返す。ホーム配下のどのファイルもその remote の鍵になるため。source を明示した remote は、cwd の git の鍵と一致したときだけ、その作業ツリーで同じ判定をする（remote 鍵だけからは作業ツリーが分からないので、一致しなければ受ける）。パスは実体（決定 15）で判定するので、ホームを指すシンボリックリンクも拒否される
12. **git が読めない失敗を「origin なし」と区別する。** 先に `git rev-parse --show-toplevel` が通ることを確かめる。dubious ownership の作業ツリーでは `git config --get remote.origin.url` がリポジトリの設定を読まずに「キーなし」を返し、origin なしと区別できないため。git 自体が失敗したら（未導入・終了コード≠0・dubious ownership）、鍵は取得失敗とし、パスの前方一致には落とさない（本来の鍵で引ける対応づけを見落とし、別の枠のパス対応づけに当たりうる）。枠が 2 つ以上なら拒否し、reason に git の失敗内容を入れる。枠が 1 つならその枠を使う（どの対応づけもその枠を指すので結果は変わらない）。status では `resolved.reason` に入れ、status 自体は落とさない。origin の無い git は従来どおり git ルートの絶対パスを鍵にする。パスの対応づけは「origin のある git ルートの中」には当たらない（鍵が remote になるため）
13. **パスの対応づけが重なれば最長一致。** `/work` → A と `/work/clientB` → B があれば `/work/clientB/x` は B。完全一致の重複（手で書いた sources.json）だけ曖昧として拒否する。map_source は追加時に、ほかの枠のより短い・長い対応づけと重なればその旨を message に含める
14. **account 引数が既存の対応づけと食い違っても送るが、結果に `mapped_to` を載せる。** 利用者が名指ししたアカウントを止めると、意図した例外の送信ができなくなるため。ツール説明で「mapped_to が返ったら、利用者が意図したアカウントか確認する」と指示する。map_source は、同じ到達元が別の枠に対応づいていれば追加を拒否し、先に remove を求める。1 回の注入で送り先を恒久的に付け替えられないようにするため
15. **source 入力は 2 形だけ受け付ける。** 絶対パス（POSIX `/…`、Windows `X:\…` / `X:/…`、UNC `\\server\share\…` / `//server/share/…`）と git remote。パスは鍵と同じく realpath で実体にそろえ、存在しないパスは対応づけない（実体にそろえられず、鍵と照合できないため）。外すときは存在しなくてもよく、`//`・`.`・`..` を畳んで（Windows の形は `win32.normalize` で）照合する（消えたディレクトリの対応づけを外せるように）。remote は clone の URL（scheme 付き・`user@host:path` の scp 形式）なら host にドットが無くても受け（社内 git）、`host/org/repo` 形は host にドットを要る。`owner/repo` の短縮形は鍵と一致しないので拒否し、`github.com/owner/repo` の形と、ドットの無い host は clone の URL で渡せることを示す。scheme の無い `host:443/org/repo` は port を落として `host/org/repo` にする（`ssh://host:22/org/repo` と同じ鍵）。`user@` 付きの scp 形式には port が無いので、`git@host:123/repo` の `123` はパスとして残す。Windows のパスは区切り（`\` と `/`）とドライブ文字の大小を問わず、区切り単位で前方一致させる

### 検証

- ユニット: 鍵の正規化（https / ssh / scp の小文字化 / `.git` 有無 / 末尾 `/` / scheme 無しの port / UNC をパスとして扱う / パスの realpath（シンボリックリンク・大小を区別しない FS の綴り））、解決順 1→5 の各分岐、最長一致、曖昧時の拒否、git が読めないときの拒否、移行（写し・refresh での確認・account 有り・無し・壊れたトークン・invalid_client・通信の失敗・クライアント無し・印による再試行の抑止（先に再ログイン済み・refresh_token のローテーション・失効＋他の枠）と内容が変わったときの写し直し）、再ログインが他の枠に触らないこと、枠の写しのクライアントで refresh すること、map_source の付け替え拒否と広すぎるパス・作業ツリーの拒否（source を明示した remote は cwd の鍵と一致したとき）、存在しないパスの拒否と外せること、source 入力のパスの畳み込みと clone URL の受理。`defaultGitOriginUrl` だけは実際の git で確かめる（origin あり・なし・偽の .git・git が PATH に無い）
- 実機: 2 アカウント（Workspace + 個人 Gmail、別クライアント）で `login_hint` の効き、`map_source` 後の自動解決、未登録リポジトリからの拒否と `suggest_map`・`mapped_to`、0.4.0 の token.json からの写し（0.4.0 のプロセスと併用して両方が動くこと）、所有者の違うリポジトリ（dubious ownership）での拒否、Windows のドライブ付きパスの対応づけ

### 実アカウントで確認済み（2026-10-16、Workspace 内部クライアント + 個人 Gmail の External クライアント）

隔離した `DRIVELIFT_CONFIG_DIR` に 0.4.0 の実トークンを写して実施。

- 0.4.0 の `token.json`（account 入り）が `accounts/ren-watanabe@pacenote.jp/` に写され、`legacy-migration.json` ができる。旧ファイルはバイト一致で残り、2 回目の doctor で変化しない
- 個人クライアントを `import-secret` で取り込んでも既存の枠は従来のクライアントで `ready` のまま。`login --hint <gmail>` の認可 URL に `prompt=select_account+consent` と `login_hint` が付き、個人アカウントでログインが完了して 2 枠目ができる。本人の目視: アカウント選択画面は出て、選択肢は hint の gmail だけだった（Workspace アカウントは並ばなかった。ブラウザのセッション状況による可能性あり）
- 2 枠で未登録の場所（`/private/tmp`、`~/personal-dev`）からは `account_unresolved`（終了コード 2、`candidates` 2 件、送信なし）
- `--account` 付きの upload は通り、`suggest_map` に `github.com/rererr/drivelift`（小文字）。`map` の引数省略は候補表示のみで書かない
- `map` 登録後は doctor の resolved が `by source` になり、`--account` 無しの upload が `source` 付きで通る
- 対応づけと違う `--account` は通したうえで `mapped_to` を返し、CLI は標準エラーに注記を出す
- 同じ到達元を別の枠に `map` すると「先に remove」で拒否（終了コード 2）
- 同じ設定ディレクトリで `npx drivelift@0`（0.4.0）の doctor が `ready`（旧 token.json を読む）。0.5.0 と 0.4.0 の併用が成立
- 未実施: dubious ownership のリポジトリでの拒否、Windows のドライブ付きパス

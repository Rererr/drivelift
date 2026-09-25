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
                └── status.ts (状態→次の一手)
```

MCP サーバーと CLI は同じハンドラ（core.ts）を使う。外部依存（設定ディレクトリ・fetch・時計・ブラウザ起動）は `Deps` で注入し、テストは Google に接続しない。

## 状態機械

導入状態は 5 つ。どの状態でも同じ形（state / message / next_steps / urls）で返す。

| 状態 | 検出 | 次の一手 |
|--|--|--|
| no_client | client_secret.json も環境変数もない | Console の 4 リンクと保存先パス |
| no_token | token.json がない | auth_start |
| token_invalid | refresh が invalid_grant | auth_start。7 日周期なら同意画面の公開状態を疑う |
| api_disabled | Drive API が 403 accessNotConfigured | 応答に含まれる有効化 URL |
| ready | about.get が通る | upload |

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
- ループバックの待ち受けは state を最初に照合し、state の無いリクエストは成功にも失敗にも進めない。他サイトからのポート総当たりでログインを妨害できない
- 応答 HTML に埋める外部由来の値（Google の error 値・エラーメッセージ）はエスケープする
- code 交換中の重複コールバックは 409 で無視し、二重交換しない
- stdio 切断時は待ち受け中のログインを閉じ、ポートを握った孤児プロセスを残さない

## 実アカウントで確認済み（2026-09-25、Google Workspace・内部クライアント）

- パス付きの redirect_uri（`127.0.0.1:<port>/callback`）で Desktop クライアントのループバックが通る
- resumable セッション URL への PUT（Authorization 付き）で xlsx が Google スプレッドシートに変換される
- 変換後も列幅・塗り・タブが保たれ、埋め込み画像は解像度（1400px）を保ったまま残る
- 別のクライアント JSON を取り込むと旧トークンを破棄し、`no_token` から再ログインに進む
- `gcloud_setup` の計画表示と実行（プロジェクト作成・Drive API 有効化）

注意: Sheets は xlsx の行高（pt）を px として取り込み、Hyperlink に display が無いと表示文字を `#gid=…` に置き換える。どちらも drivelift ではなく xlsx を作る側で対処する事柄なので、README には書かず利用側（pacenote の test-report.py）に記録した。

- drivelift が作っていない既存フォルダ（共有ドライブ内）を `folder_id` に指定しても、その中にファイルとフォルダを作れる。フォルダ自体の読み取りは 404 になる（drive.file は作成の親にだけ ID で書き込める）
- `share` で domain に閲覧権限を付けられる（`allowFileDiscovery: false` ＝リンクを知っている組織内の人だけ）
- `folder_path` のフォルダは2回目に再利用される。マイドライブ直下（既定の corpora）と共有ドライブ内のフォルダの下（`corpora=allDrives`）の両方で確認。並べ替えは API の orderBy を使わず、全ページを取って手元で最古を選ぶ。検索が欠けた（incompleteSearch）うえで1件も無いときは、重複を避けるため作らずに止める
- md → Docs は Markdown として解釈される（見出し・表になる）
- `replace_id` での差し替え（2026-09-25）: ID・URL が変わらず、中身（本文・画像シートの画像・シート間リンク）が新しい版になり、domain の閲覧権限が残る。ゴミ箱のファイル・名前違い・drivelift が作っていないフォルダの ID は送信前に拒否される。他アプリが作ったファイルの ID と種類違いの拒否は実測していない（前者は drive.file の仕様で 404 になるはず、後者はユニットテストのみ）。名前は NFC に正規化して比べる。MCP の注釈は `destructiveHint: true` にした

## 未検証（実アカウントで確かめる）

2. resumable セッション URL への PUT に Authorization が要るか（付けた状態では通る。外した場合は未確認）
4. Console の URL（`auth/overview`・`auth/clients/create`）は新 UI のもの。旧 UI に戻された場合は status.ts の 1 テーブルを直す
6. `xlsm` → Sheets ほか、xlsx・csv・md 以外の変換（`about.importFormats` で確認できる）
7. Windows での PowerShell 経由のブラウザ起動、Linux の xdg-open

## 今後

- `drive` スコープの opt-in は不要になった（既存フォルダ・共有ドライブへの書き込みは drive.file で通る）。なお `folder_id` に他人が共有したフォルダを指定すると、そこへファイルを置けること自体は drive.file でも同じなので、description では「利用者が指定した置き先にだけ置く」前提を崩さない
- pacenote の `/test-report` スキルを rclone 経由から `drivelift upload` に差し替える
- npm 公開（`drivelift@0`。利用者側は `npx -y drivelift@0` でメジャー固定）

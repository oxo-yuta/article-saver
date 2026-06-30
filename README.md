# Article → Obsidian Saver

**X**（Articles / 長尺記事）と **note** の記事ページを、本文Markdown＋画像実体としてObsidian Vaultに保存するChrome拡張機能です。

- 記事ページを自動検知し、画面右下に「**Obsidianに保存**」ボタンを表示
- 拡張機能アイコンのポップアップからも保存可能
- 本文をMarkdown化（フロントマター付き／見出し・段落・引用・リスト・コード・画像の順序を保持）
- 本文画像を**最高画質でダウンロード**し、Obsidianの添付フォルダに保存
- Markdownからは `![[...]]`（Wikilink埋め込み）で画像を参照
- 保存元に応じて `x-article` / `note-article` タグを自動付与

---

このツールが役に立ったら、ぜひコーヒーで応援してもらえると嬉しいです ☕

<p>
  <a href="https://www.buymeacoffee.com/spadelovesa" target="_blank">
    <img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" height="50" width="210">
  </a>
</p>

---

## 仕組みと前提（重要）

Chrome拡張は、セキュリティ上 **ブラウザのダウンロードフォルダの外へ直接ファイルを書き込めません**（`chrome.downloads` はダウンロードフォルダ起点の相対パスのみ）。

そこで本拡張は **ダウンロードフォルダ内に作ったVaultへのシンボリックリンク経由** で保存します。リンクを1度張れば、以降は自動的にiCloud上のVaultへ実体が書き込まれます。

```
chrome.downloads → ~/Downloads/ObsidianVault/（シンボリックリンク）→ 実際のVault
```

---

## セットアップ

### 1. シンボリックリンクを作成（初回のみ・1コマンド）

ターミナルで、自分のVaultパスをダウンロードフォルダ内にリンクします。
`/path/to/your/Vault` を、あなたのObsidian Vaultの絶対パスに置き換えてください。

```bash
ln -s "/path/to/your/Vault" ~/Downloads/ObsidianVault
```

> iCloud同期のObsidian Vaultを使っている場合、Vaultパスは通常
> `~/Library/Mobile Documents/iCloud~md~obsidian/Documents/<Vault名>` です。

確認:

```bash
ls -la ~/Downloads/ObsidianVault/   # Vaultの中身が見えればOK
```

> リンク名は任意です。`ObsidianVault` 以外にした場合は、拡張の設定「Vault相対パス」を合わせてください。

### 2. 拡張機能をChromeに読み込む

1. Chromeで `chrome://extensions` を開く
2. 右上の「**デベロッパーモード**」をON
3. 「**パッケージ化されていない拡張機能を読み込む**」をクリック
4. このフォルダ（`article-saver`）を選択

> **拡張を更新するとき:** 最新版を取得してから、Chromeで再読み込みします。
>
> ```bash
> cd /path/to/article-saver
> git pull
> ```
>
> その後 `chrome://extensions` を開き、本拡張のカード右下にある**再読み込みアイコン（⟳）**をクリックすれば反映されます（Chromeの再起動は不要）。設定（Vault相対パスやタグ）は保持されます。

### 3. Chromeのダウンロード設定を確認

`chrome://settings/downloads` で
**「ダウンロード前に各ファイルの保存場所を確認する」をOFF** にしてください。
ONのままだと保存のたびに保存ダイアログが出ます。

### 4. 拡張の設定を開く

拡張アイコン → ポップアップの「⚙ 設定を開く」、または `chrome://extensions` の「詳細 → 拡張機能のオプション」から。

| 設定項目 | 既定値 | 説明 |
|---|---|---|
| Vault相対パス | `ObsidianVault` | 手順1で作ったリンク名 |
| ノート保存サブフォルダ | `Clippings` | `.md` の保存先（Vault内） |
| 添付サブフォルダ | `Clippings/attachments` | 画像の保存先（Vault内） |
| ファイル名形式 | `{date}-{slug}` | `{date}` `{slug}` `{handle}` が使える |
| タグ | `clipped` | フロントマターの `tags`。これに加え保存元の `x-article` / `note-article` が自動付与される |

設定画面の「保存先プレビュー」で実際の保存パスを確認できます。

---

## 使い方

1. 記事ページを開く
   - X: `https://x.com/<handle>/status/<id>`（Articles / 長尺記事）
   - note: `https://note.com/<urlname>/n/<id>`
2. 画面右下の「**Obsidianに保存**」ボタン、または拡張アイコン → 「Obsidianに保存」をクリック
3. 完了通知が出れば成功。Vaultの `Clippings/` にノート、`Clippings/attachments/` に画像が保存されます

保存されるMarkdownの例:

```markdown
---
title: "記事のタイトル"
author: "著者の表示名"
author_handle: "@author_handle"
source: "https://x.com/author_handle/status/1234567890123456789"
published_at: "2026-06-05T03:30:14.000Z"
saved_at: 2026-06-30
tags:
  - x-article
---

# 記事のタイトル

本文段落…

![[Clippings/attachments/2026-06-30-記事のタイトル-1.jpg]]
```

---

## 構成

```
article-saver/
├── manifest.json            # MV3マニフェスト
├── src/
│   ├── background.js        # 画像fetch・ダウンロード保存（Service Worker）
│   ├── content/
│   │   ├── content.js       # 記事検知・ボタン注入・抽出/Markdown化の起点
│   │   └── content.css      # 注入ボタンのスタイル
│   ├── lib/
│   │   ├── extractor.js      # サイト振り分けディスパッチャ（ホスト名で X/note を選択）
│   │   ├── extractor-x.js    # X の DOM → 構造化データ
│   │   ├── extractor-note.js # note の DOM → 構造化データ
│   │   ├── markdown.js       # 構造化データ → Markdown
│   │   └── filename.js       # スラッグ/日付/パスのユーティリティ
│   ├── popup/               # アイコンクリック時のポップアップ
│   └── options/             # 設定画面
└── icons/
```

本文抽出のセレクタはサイトごとに分離しています。DOM変更で抽出が壊れた場合は、
**X は `src/lib/extractor-x.js`**（`twitterArticleReadView` / `longform-*` など）、
**note は `src/lib/extractor-note.js`**（`note-common-styles__textnote-body` など）を修正してください。
新しいサイトを追加する場合は、新規 `extractor-<site>.js` を作り `extractor.js` の `SITES` に登録します。

---

## トラブルシューティング

| 症状 | 対処 |
|---|---|
| 保存のたびに保存ダイアログが出る | `chrome://settings/downloads` の「保存場所を確認する」をOFF |
| Vaultに反映されない | `~/Downloads/<リンク名>` が正しくVaultを指しているか `ls -la` で確認 |
| 「記事ページではありません」と出る | Xは記事（Articles）ページか、noteは記事（`/n/`）ページか確認。Xの通常ポストでは動作しません |
| 画像が保存されない | コンソール（拡張の「Service Worker」リンク）でfetchエラーを確認 |
| ボタンが出ない | ページ更新。DOM変更時は X→`extractor-x.js` / note→`extractor-note.js` のセレクタ更新が必要 |

---

## 注意

- 保存対象はXの「記事（Articles / 長尺記事）」と、noteの記事ページです。Xの通常のポストやスレッドは対象外です。
- 個人利用を想定しています。保存したコンテンツの著作権は原著者に帰属します。

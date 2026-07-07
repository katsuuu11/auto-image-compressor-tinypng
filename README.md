# ImageCompressor (Electron メニューバーアプリ)

画像自動圧縮ツールを Electron 化し、macOS メニューバー常駐アプリとして利用できます。

## 開発セットアップ

```bash
npm install
cd app && npm install && cd ..
npm start
```

## ビルド

```bash
npm run build
```

`dist/` 配下に `.dmg` が生成されます。

## 付属コンポーネント

- `app/`: Node.js 圧縮サーバー（Express + sharp）

## 社内導入手順

### 必要なもの
- macOS（Intel / Apple Silicon）

### STEP 1 : アプリをインストール
1. 配布された `ImageCompressor-1.0.0.dmg` をダブルクリック
2. 開いたウィンドウで `ImageCompressor` を `Applications` フォルダにドラッグ
3. `Applications` フォルダから `ImageCompressor` を起動

> 「開発元を確認できません」と表示された場合は、右クリック →「開く」→「開く」をクリック

### 使い方
セットアップ後は何も操作不要。監視対象フォルダに画像を保存するだけで自動圧縮されます。
圧縮後の画像は監視対象フォルダ内に自動作成される `compressed/` フォルダへ、元ファイル名のまま保存されます。
対応フォーマット：PNG（メイン対象） / JPG・JPEG（補助対象、通常は1MB以上のみ）

WebP / PDF / GIF / SVG は自動圧縮対象外です。TinyPNG は強力圧縮モード、またはアプリ設定で ON にした場合のみ使用します。圧縮後のファイルサイズが元画像以上になる場合は `compressed/` へ保存せず、元画像だけを残します。

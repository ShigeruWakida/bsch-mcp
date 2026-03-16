# BSch3V MCP Server

[BSch3V](http://www.suigyodo.com/online/schsoft.htm) 回路図エディタをAIが操作するためのMCP (Model Context Protocol) サーバーです。

Claude Code や他のMCP対応AIツールから、BSch3Vの回路図ファイル(.CE3)とライブラリファイル(.LB3)を読み書き・編集できます。

## 機能

### 回路図の読み書き
- `read_schematic` / `write_schematic` / `create_schematic` — CE3ファイルの読み込み・書き出し・新規作成
- `read_library` / `list_libraries` — LB3ライブラリの読み込み・一覧取得
- `get_library_component` — ライブラリまたは既存CE3から部品データを取得

### 部品操作
- `add_component` / `remove_component` / `move_component` — 部品の配置・削除・移動
- `rotate_component` — 回転・反転
- `set_component_properties` — 属性変更（名前、番号、表示位置等）
- `get_component_pins` — ピン座標の取得

### 配線
- `add_wire` / `remove_wire` — ワイヤーの追加・削除
- `add_junction` — ジャンクション（接続点）の追加
- `add_bus` / `add_bus_entry` / `add_entry` — バス配線
- `add_label` / `add_tag` — ネットラベル・タグ

### 解析
- `get_schematic_summary` — 回路図の概要取得
- `get_net_connections` — ネットリスト生成（NL3W互換）

### 部品作成
- `create_component` — ピン定義から矩形IC部品を新規作成
- `modify_library_component` — 既存部品のパターンを流用して新部品を作成

### その他
- `add_comment` — テキストコメント
- `add_dash` / `add_marker` — 装飾線・マーカー
- `set_sheet_size` / `set_visible_layers` — シート設定

## セットアップ

### 必要なもの
- Node.js v18以上
- BSch3V（回路図の表示確認用）

### インストール

```bash
git clone https://github.com/YOUR_USERNAME/bsch-mcp.git
cd bsch-mcp
npm install
npm run build
```

### Claude Code での設定

プロジェクトの `.mcp.json` に以下を追加:

```json
{
  "mcpServers": {
    "bsch3v": {
      "command": "node",
      "args": ["/path/to/bsch-mcp/dist/index.js"],
      "env": {
        "BSCH3V_DIR": "/path/to/BSch3V"
      }
    }
  }
}
```

`BSCH3V_DIR` はBSch3Vのインストールディレクトリ（`BSCH3.INI` があるディレクトリ）を指定します。省略した場合、一般的なインストール先を自動検索します。

## 使い方

### 既存の回路図を読む

```
> LEDPORT.CE3を読んで回路を説明して
```

AIが `read_schematic` と `get_net_connections` を使って回路図を解析し、回路の動作を説明します。

### 回路図を編集する

```
> Q4出力にLEDを追加して
```

AIが `add_component`, `add_wire`, `remove_component` 等を使って回路図を編集します。

### 新しい回路図を作る

```
> 1kHzのローパスフィルタ回路を設計して
```

AIが回路設計を行い、`create_schematic`, `add_component`, `add_wire` 等で回路図を作成します。

## 対応フォーマット

- **CE3** — BSch3V回路図ファイル（UTF-8/CP932自動検出、書き出しはUTF-8）
- **LB3** — BSch3Vライブラリファイル
- **BSCH3.INI** — BSch3V設定ファイル（UTF-16LE、ライブラリパスの自動取得）

## 技術仕様

- TypeScript / Node.js
- MCP SDK: `@modelcontextprotocol/sdk`
- CE3/LB3パーサー・シリアライザを独自実装
- ネットリスト生成はNL3W（BSch3V付属ツール）のロジックをTypeScriptに移植
- ピン座標計算はBSch3Vソースコード（C++）から正確に移植

## ライセンス

ISC

## 関連リンク

- [BSch3V](http://www.suigyodo.com/online/schsoft.htm) — 水魚堂 岡田仁史氏による回路図エディタ
- [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) — Anthropic によるAIツール連携プロトコル

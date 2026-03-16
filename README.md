# BSch3V MCP Server

**AIを使って回路図を設計・編集するためのMCPサーバーです。**

Claude等のAIと対話しながら、回路図エディタ [BSch3V](http://www.suigyodo.com/online/schsoft.htm) の回路図を自動生成・編集することを目的としています。AIが回路設計の知識を活かして部品選定・配置・配線・ネットリスト検証まで一貫して行えるようになることを目指しています。

## できること

### 回路図の読み取り・解析
- CE3ファイルの読み込みとJSON構造への変換
- ネットリスト生成（NL3W互換の接続解析）
- 部品一覧・ピン座標・接続関係の取得

### 回路図の作成
- 新規回路図の作成と部品配置
- ワイヤー配線・ジャンクション・バス配線
- 電源シンボル・ネットラベル・タグの配置

### 回路図の編集
- 部品の追加・削除・移動・回転・反転
- ワイヤーの追加・削除
- 部品属性（名前、番号、表示位置）の変更
- シートサイズの変更

### 部品の管理
- BSch3Vライブラリ（LB3）からの部品検索・取得
- 既存の回路図（CE3）からの部品コピー
- ピン定義からの新規矩形IC部品作成
- 既存シンボルの流用（ピン番号・名前の変更）

## できないこと

- きれいで見た目の整った回路図を書くこと。部品の配置や配線のルーティングはAIが座標を計算して行いますが、人間が手作業で描いたような整った回路図にはなりません。AIが生成した回路図は、BSch3V上で手動で調整することを前提としています。

## MCPツール一覧（30ツール）

<details>
<summary>回路図の読み書き（5ツール）</summary>

| ツール | 説明 |
|---|---|
| `read_schematic` | CE3ファイルを読み込みJSON構造で返す |
| `write_schematic` | メモリ上の回路図をCE3ファイルに保存 |
| `create_schematic` | 新規空回路図を作成 |
| `read_library` | LB3ライブラリの全部品情報を取得 |
| `list_libraries` | 利用可能なLB3ファイル一覧（BSCH3.INIから自動検出） |

</details>

<details>
<summary>部品操作（10ツール）</summary>

| ツール | 説明 |
|---|---|
| `add_component` | 部品を配置 |
| `remove_component` | 部品を削除 |
| `move_component` | 部品を移動 |
| `rotate_component` | 部品を回転・反転 |
| `set_component_properties` | 部品属性を変更 |
| `get_component_pins` | ピン座標を取得 |
| `get_library_component` | ライブラリ/CE3から部品データを取得 |
| `create_component` | ピン定義から新規部品を作成 |
| `modify_library_component` | 既存シンボルを流用して新部品を作成 |
| `get_schematic_summary` | 回路図の部品一覧・要素数を取得 |

</details>

<details>
<summary>配線（8ツール）</summary>

| ツール | 説明 |
|---|---|
| `add_wire` | ワイヤーを追加 |
| `remove_wire` | ワイヤーを削除 |
| `add_junction` | ジャンクションを追加 |
| `add_bus` | バスを追加 |
| `add_bus_entry` | バスエントリーを追加 |
| `add_entry` | エントリーを追加 |
| `add_label` | ネットラベルを追加 |
| `add_tag` | タグを追加 |

</details>

<details>
<summary>解析（1ツール）</summary>

| ツール | 説明 |
|---|---|
| `get_net_connections` | ネットリスト生成・接続解析 |

</details>

<details>
<summary>装飾・設定（4ツール）</summary>

| ツール | 説明 |
|---|---|
| `add_comment` | テキストコメントを追加 |
| `add_dash` | 装飾線を追加 |
| `add_marker` | マーカー線を追加 |
| `set_sheet_size` | シートサイズを変更 |
| `set_visible_layers` | レイヤー表示を設定 |

</details>

## セットアップ

### 必要なもの
- Node.js v18以上
- BSch3V（回路図の表示確認用、[ダウンロード](http://www.suigyodo.com/online/schsoft.htm)）

### インストール

```bash
git clone https://github.com/YOUR_USERNAME/bsch-mcp.git
cd bsch-mcp
npm install
npm run build
```

### Claude Code での設定

プロジェクトの `.mcp.json` を作成:

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

`BSCH3V_DIR` はBSch3Vのインストールディレクトリ（`BSCH3.INI` があるディレクトリ）です。省略時は自動検索します。

## 使用例

### 既存の回路図を理解する

```
> LEDPORT.CE3を読んで回路を説明して
```

AIが回路図を読み込み、部品構成・接続関係・動作を分析して説明します。

### 回路図を編集する

```
> U1のQ4出力にLEDを追加して
```

AIが必要な部品（抵抗、LED、GNDシンボル）を追加し、ワイヤーで接続します。

### 新しい回路図を設計・作成する

```
> 1kHzカットオフの4次バタワースLPFを設計して
```

AIが回路方式の検討、部品定数の計算、回路図の作成、ネットリストの検証まで行います。

### データシートから部品を作成する

```
> PIC32のデータシートからピン配置を読み取って部品を作成して
```

AIがピン定義から回路図シンボルを自動生成します。

## 対応フォーマット

| ファイル | 説明 | エンコーディング |
|---|---|---|
| `.CE3` | 回路図 | UTF-8 / CP932（自動検出、書き出しはUTF-8） |
| `.LB3` | ライブラリ | UTF-8 / CP932 |
| `BSCH3.INI` | BSch3V設定 | UTF-16LE |

## 技術仕様

- **言語**: TypeScript / Node.js
- **MCP SDK**: `@modelcontextprotocol/sdk`
- **パーサー**: CE3/LB3テキストフォーマットの独自実装
- **ネットリスト**: NL3W（BSch3V付属）のロジックをTypeScriptに移植
- **ピン座標計算**: BSch3Vソースコード（C++）から移植、回転・反転対応

## ライセンス

ISC

## 関連リンク

- [BSch3V](http://www.suigyodo.com/online/schsoft.htm) — 水魚堂 岡田仁史氏による回路図エディタ
- [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) — Anthropic によるAIツール連携プロトコル

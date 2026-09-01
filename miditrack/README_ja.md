# miditrack 開発ガイド

この文書は`miditrack`パッケージのコントリビューターとメンテナー向けです。インストール、ブラウザ上のワークフロー、対応形式、コマンド例は、リポジトリルートの[ユーザーマニュアル](../README_ja.md)（[英語版](../README.md)）を参照してください。

## 役割とドキュメントの管理範囲

`miditrack`は、同梱コンバーターCLIを通じて対応するチップチューンを変換し、生成されたMIDIを編集して、ローカルで音声をレンダリングするFlaskアプリケーションです。

- `../README.md`と`../README_ja.md`はエンドユーザー向けマニュアルです。構成と実用的な挙動を同期させます。
- このREADMEは、コントリビューター向けのセットアップ、アーキテクチャ、実行時の契約、検証コマンドを記録します。
- `CLAUDE.md`は詳細な実装履歴、不変条件、設計理由を記録します。開発者向けの契約が変わる場合は更新します。
- 各コンバーターは自身のREADMEとCLAUDE.mdを管理します。ここにCLIオプションのリファレンスを重複して書きません。

## 開発セットアップ

```bash
cd miditrack
python3 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install -e .
```

ラッパー経由でアプリケーションを実行します。

```bash
./miditrack.sh --no-browser
```

ラッパーは自身の場所を解決し、常にこのパッケージの`.venv`を使い、呼び出し元の作業ディレクトリを保ったまま全引数を渡します。暗黙にシステムのPythonへフォールバックする実装へ変更しないでください。

### ローカル開発用の外部ツール

| 用途 | コマンドまたは依存関係 |
|---|---|
| SoundFontレンダリング | `brew install fluid-synth`と`.sf2`/`.sf3`のSoundFont |
| 実音声ステムのミックスとトラック別出力 | `brew install ffmpeg` |
| 実音声ステムの速度・ピッチ変更 | `brew install rubberband` |
| VGMの原曲の音源 | `cd ../vgm2midi && ./scripts/build-native.sh` |

SoundFont探索を上書きするには`MIDI2WAV_SOUNDFONT`を設定します。任意の`VGM2MIDI_STEMS_HELPER`上書きは、既定以外のVGMネイティブヘルパーを指定します。探索仕様を変更する場合は、ユーザーマニュアルにある通常のSoundFont配置先の一覧を維持してください。

## アーキテクチャ

```text
miditrack/
  miditrack.sh             パッケージ仮想環境の安定したランチャー
  midi2wav.sh              レンダラーが使うFluidSynthラッパー
  src/miditrack/
    cli.py                 CLI解析とサーバー起動
    web.py                 Flaskルート、セッション、リクエスト検証
    convert.py             同梱コンバーターの解決と音源変換
    render.py              MIDI-to-WAVレンダリングとSoundFont探索
    rubberband.py          実音声ステムの直接的な速度・ピッチ同期
    midi.py                MIDI解析と編集
    pianoroll.py           読み取り専用のピアノロールデータ抽出
    project.py             .miditrackアーカイブのシリアライズ
    preferences.py         ローカル保存する設定
    static/                ブラウザクライアントのアセット
  tests/                   Pythonテストスイート
```

ブラウザクライアントは意図的に薄いローカルフロントエンドです。MIDI編集とレンダリング判断はサーバー側に残し、レンダリング済みアセットはセッション単位の一時ファイルです。

## 実行時の契約

### コンバーター境界

`convert.py`は、同梱する`nsf2midi`、`spc2midi`、`vgm2midi`を明示的なargvリストで呼び出します。コンバーターはMIDI（および形式固有のサイドカー）を出力し、汎用SoundFont WAVのレンダリングを依頼してはいけません。変換後のレンダリングは`miditrack`が`midi2wav.sh`を通じて担当します。

コンバーターの実行ファイルは次の環境変数で明示的に上書きできます。

- `NSF2MIDI_BIN`
- `SPC2MIDI_BIN`
- `VGM2MIDI_BIN`

設定済みだが使用できない上書き値は、別の実行ファイルへ黙ってフォールバックせず、明確に失敗させます。

### 音声レンダリング境界

`render.resolve_midi2wav_bin()`は、次の順序でレンダラーを解決します。

1. 実行可能な場合の`MIDI2WAV_BIN`
2. パッケージ内の`miditrack/midi2wav.sh`
3. `PATH`上の`midi2wav`

`render.py`、`convert.py`、`rubberband.py`は、シェルを使わずargv配列をサブプロセスへ渡します。リポジトリのパスには空白やシェルのメタ文字を含む場合があります。

`midi2wav.sh`は、自身のパスからリポジトリルートを導出します。スクリプトを`miditrack/`へ移動した後も、同梱するSoundFontディレクトリは`<リポジトリ>/soundfonts`のままです。

### ローカルセキュリティモデル

サーバーはローカルにバインドし、起動ごとのトークンでAPIリクエストを認証します。アップロードはローカルユーザーの入力として扱いますが、ZIP展開の上限とパス検証を維持してください。任意のファイルシステム読み取りやシェルコマンド文字列を許すルートを追加しないでください。

## 検証

リポジトリルートからPythonテストを実行します。

```bash
miditrack/.venv/bin/python -m pytest -q miditrack/tests
```

レンダラーまたはラッパーを変更した場合は、追加で確認します。

```bash
bash -n miditrack/midi2wav.sh
miditrack/midi2wav.sh --help
```

コンバーター境界をまたぐ変更では、影響するコンバーターもビルド・テストします。

```bash
make -C nsf2midi test
./build.sh                 # spc2midi/ 内で実行
npm test                   # vgm2midi/ 内で実行
```

引き継ぎ前には`git diff --check`を実行します。利用者に見える挙動を変更する場合は、ルートの英語版・日本語版マニュアルを同時に更新し、見出し、例、オプション表の構成が揃っていることを確認します。

## 実装時の参照先

- [CLAUDE.md](CLAUDE.md): 詳細な設計履歴と実装上の不変条件。
- [../README_ja.md](../README_ja.md): 利用者向けワークフローとトラブルシューティング。
- [../nsf2midi/README.md](../nsf2midi/README.md)、[../spc2midi/README.md](../spc2midi/README.md)、[../vgm2midi/README.md](../vgm2midi/README.md): コンバーター固有のマニュアル。

## ライセンス

MIT

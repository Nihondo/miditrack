# nsf2midi

NSF (NES Sound Format) 音楽ファイルをエミュレーションし、スタンダード MIDI
ファイル (`.mid`) に変換する macOS 用コマンドラインツールです。オリジナル
のファミコン音源をエミュレートし、そのレジスタ状態からノートを検出して
変換します。

これは Windows GUI ツール `nsf2midi` 0.14 を macOS/arm64 向けにゼロから
再実装したものです。オリジナルの 32bit 実行ファイルは Apple Silicon 上で
は動作せず、そもそも CLI を持たないため作成しました。オリジナルと同じ
`.mdf` 音色定義ファイル形式を読み込めます。

## 特徴

- NSF/NSFE ファイルを GM (General MIDI) 準拠のスタンダード MIDI ファイル
  (format 1) に変換
- APU (矩形波×2、三角波、ノイズ、DPCM) に加え、VRC6・FDS・FME-7 (Sunsoft
  5B)・N106/N163 拡張音源をエミュレート
- `.mdf` 音色定義ファイルを読み込み、チャンネルごとの音色・音量・ピッチ
  ベンド・ノートオン検出感度・単音/ポルタメントモードなどを設定可能。
  オリジナルの `default.mdf` とそのまま互換
- `--chip-wav` で、ノイズ/DPCM チャンネルを GM ドラムの MIDI ノートでは
  なく、実機チップエミュレーションによる音声として別の `.wav` にレンダ
  リング（より原音に近いパーカッションをミックスで使いたい場合。詳細は
  下記）
- 外部依存なしの単一 arm64 バイナリ

## インストール

ソースからビルドします (Xcode Command Line Tools が必要):

```
make
```

これにより、実行時の外部依存を一切持たない単一バイナリ `nsf2midi` が
生成されます。任意の場所にコピーして使えます:

```
cp nsf2midi /usr/local/bin/
```

## 使い方

```
nsf2midi [options] <input.nsf> [output.mid]
```

`output.mid` を省略した場合、入力ファイル名の拡張子を `.mid` に変えた
ものが出力先になります。

### オプション

| オプション | 説明 |
|---|---|
| `-m, --mdf <file>` | 音色定義ファイル (既定: `nsf2midi` 実行ファイルと同じ場所の `gm.mdf`。オリジナルと完全互換にしたい場合は `-m default.mdf` を指定) |
| `-t, --track <n>` | 変換するトラック番号 (0 起点、既定: `0`) |
| `-d, --duration <sec>` | 変換する秒数 (既定: NSFE のトラック長があればそれ、無ければ 180 秒) |
| `-l, --list` | 曲名・トラック一覧・検出した拡張音源を表示して終了 |
| `--pal` | PAL タイミングを強制 (既定: NSF ヘッダから自動判定) |
| `-v, --verbose` | 検出したノートを都度 stderr に出力 |
| `--chip-wav <file>` | ノイズ/DPCM チャンネルを GM ドラムの MIDI ノートではなく、実機チップエミュレーションによる音声として `<file>` にレンダリングする。既定ではこの2チャンネルを `.mid` からも除外する |
| `--keep-chip-midi` | `--chip-wav` 指定時、ノイズ/DPCM の GM ドラムノートも `.mid` に残す（`--chip-wav` が必須） |
| `--track-metadata <file>` | 各MIDIトラックとNESチャンネルの対応を記したJSON sidecarを書き出す。後から任意のチャンネルを選んでレンダリングする `--chip-render`（下記）で使う |
| `--chip-render <channels> --track <n> --sample-count <n> <input.nsf> <output.wav>` | MIDI変換を一切行わず、`<channels>`（`NOISE,PCM,TRI` のようにカンマ区切りのチャンネルラベル——`--track-metadata`やMIDIトラック名と同じ表記）だけを実機チップ音として `<output.wav>` にレンダリングする |
| `-h, --help` | 使い方を表示 |

### 使用例

NSF の中身を一覧表示:

```
nsf2midi -l castlevania.nsf
```

トラック 2 (0 起点) を 90 秒分、独自の音色定義で変換:

```
nsf2midi -m my_instruments.mdf -t 2 -d 90 castlevania.nsf theme.mid
```

既定では、同梱の `gm.mdf` プリセットによってより原曲再現度を高めた GM
変換が行われます (ノイズ/PCM のドラムマップ、デューティ比に応じたリード
音色、ベロシティの強弱表現) — オプション指定は不要です:

```
nsf2midi castlevania.nsf theme.mid
```

オリジナルの Windows 版とバイト単位で一致する出力 (固定の矩形波リード、
一定のベロシティ、`Instrument` 固定のドラムノート) が欲しい場合は、
`default.mdf` を明示的に指定してください:

```
nsf2midi -m default.mdf castlevania.nsf theme.mid
```

ノイズ/DPCM を GM ドラムノートではなく実機チップ音でレンダリングする
（既定では MIDI からも除外される）:

```
nsf2midi --chip-wav theme.chip.wav castlevania.nsf theme.mid
```

## ノイズ/DPCM の実機チップ音（`--chip-wav`）

GM ドラムノートは、ファミコンのノイズ (Noise) チャンネルと DPCM (サンプ
ル再生) チャンネルの粗い代替に過ぎません — SoundFont のスネアやハイハッ
トは実機の打楽器とは似ても似つきません。`--chip-wav <file>` は、この2
チャンネルを同じエミュレーションコアで実際にレンダリングし、その実機音
を 16bit/44100Hz ステレオの WAV として出力します。長さは出力 MIDI の
再生時間と厳密に一致するため、後からサンプル単位でミックスし直せます
（例: `miditrack` の「原曲の音源」オプション）。既定
ではノイズ/DPCM チャンネルは `.mid` からも除外され、二重に鳴ることはあ
りません。`--chip-wav` と一緒に `--keep-chip-midi` を指定すると、GM ド
ラムノートも残せます（A/B 比較用など）。なお、実機ではノイズと DPCM
は同じ非線形ミキシングカーブを通るため、三角波チャンネルと一緒に鳴らし
たときの本来の寄与よりも、単独で書き出したステムは数 dB 大きく聞こえ
ます — これは仕様であり、`nsf2midi` 自身で補正するのではなく、後段の
ミックスダウン側で固定のゲインを与えて対処すべきものです。

## チャンネル単位の実機音選択（`--track-metadata` / `--chip-render`）

上記の `--chip-wav` はノイズ/DPCM固定です。`--track-metadata <file>` は
通常の変換と同時に、各MIDIトラックのNESチャンネル名
（`SQ1`/`SQ2`/`TRI`/`NOISE`/`PCM`、および検出した拡張音源チャンネル）を
記したJSON sidecarを書き出し、`--chip-render <channels> --track <n>
--sample-count <n> <input.nsf> <output.wav>` はそれら任意の組み合わせを
1回のパスで実機チップ音としてレンダリングします——MIDI変換は一切行わない
ため、繰り返し呼び出しても軽量です。これは `miditrack` のトラックごと
「原曲の音源」選択機能（自身の`CLAUDE.md`参照）が使う仕組みです。ファミ
コンのチャンネルは常にMIDIトラック1本と1対1で対応するため（`vgm2midi`が
扱う一部のマルチチップ構成と違い、2本のトラックが1つの物理チャンネルを
共有するケースが存在しない）、全チャンネルが常に選択候補となり、常に安全
な既定候補として扱われます。`--sample-count` にはsidecar自身の
`sampleCount` の値をそのまま渡してください——そうすれば、レンダリングした
WAVの長さが元の変換MIDIの再生時間と常に一致します。

## `.mdf` 音色定義ファイル

`.mdf` ファイルは INI 形式のテキストファイルで、ファミコンの音源チャン
ネルごとに 1 セクションを持ちます: `[SQUARE-CHANNEL1]`、
`[SQUARE-CHANNEL2]`、`[TRIANGELE-CHANNEL]` (原本のタイプミスですが互換の
ためそのまま)、`[NOISE-CHANNEL]`、`[PCM-CHANNEL]`、そして
`[EXTENDED-CHANNEL1]` から `[EXTENDED-CHANNEL8]` (NSF が使用する拡張音源
チップに応じて割り当て先が変わります。VRC6 は 3 チャンネル、FDS は 1
チャンネル、FME-7 は 3 チャンネル、N106/N163 は最大 8 チャンネル)。

各セクションで使えるキー:

| キー | 意味 |
|---|---|
| `Instrument` | GM プログラム番号 (0-127)。ノイズ/PCM ではそのまま GM ドラムのノート番号として使う |
| `BankHi` / `BankLo` | MIDI Bank Select MSB/LSB (CC0/CC32) |
| `Reverb` / `Chorus` | CC91 / CC93 |
| `Volume` | チャンネル音量、CC7 |
| `AttackEnabled` / `DecayEnabled` | 発音中、ファミコン側の音量エンベロープを MIDI Expression (CC11) で追従再現する |
| `PitchBendEnabled` | 半音未満の周波数変化を、ノートの打ち直しではなくピッチベンドで再現する |
| `Velocity` | 有効にすると、固定ベロシティの代わりにファミコン側の出力レベルからベロシティを算出する |
| `RelativeDividedPoint` | 新規ノートオンとみなす音量の変化幅 (レベル変化時検出)。同音の再アタックを拾うために使う |
| `AbsoluteDividedPoint` | 音を鳴らすために必要な最低音量 |
| `FrequencyChangeEnabled` | 検出した音程が変わるたびに新規ノートオンする |
| `LevelChangeEnabled` | 音量が一定以上急変したら新規ノートオンする (`RelativeDividedPoint` 参照) |
| `ChannelEnabled` | このチャンネルを変換対象にするかどうか |
| `MonoEnabled` | このチャンネル上で常に 1 音だけを鳴らし、連続する音を途切れさせずに繋げる |
| `PortamentEnabled` | `MonoEnabled` と同様の接続に加え、Portamento Time の CC も送出する |
| `NoteNumberAdjust` | このチャンネルの全ノートに加える半音単位のオフセット |
| `NoiseDrumMapEnabled` | ノイズ専用。固定の `Instrument` ノートの代わりに、実際のノイズ周期と LFSR モードから GM ドラムノート (42/38/45/37) を選ぶ |
| `PcmSampleMapEnabled` | PCM 専用。固定の `Instrument` ノートの代わりに、DPCM サンプルごとに別々の GM ドラムノート (35-81、初出順に割り当て) を使う |
| `DutyProgramChangeEnabled` | 矩形波/VRC6 パルスチャンネル専用。ノートオンのたびにデューティ比(細い/標準/太い)を反映した GM Program Change を送る。他のチャンネル種別では何もしない |

この 3 つのキーはオリジナル 0.14 の `.mdf` 形式には無い拡張キーで、既定は
すべて無効 (`0`) です。[`gm.mdf`](gm.mdf) はこれらすべてを有効化したプリ
セットで、ノイズ/PCM のドラム再現度・デューティ比を反映したリード音色・
ベロシティのダイナミクスなど、より原曲に近い GM 変換になります。
**`-m`/`--mdf` を省略した場合の既定 `.mdf` はこの `gm.mdf` です**。
`default.mdf` はオリジナル 0.14 と完全に同じ出力になるリファレンスとして
変更せず維持しており、そちらを使いたい場合は `-m default.mdf` を明示的に
指定してください。

## 制限事項

オリジナルの Windows 版と比べ、以下は意図的に未実装です:

- CoreMIDI デバイスへのライブ再生 (ファイル出力のみ)
- `.nsf::.mdf` 拡張 m3u/pls プレイリストの一括変換
- XG/GS MIDI 方言での出力 (General MIDI のみ)
- VRC7・MMC5・EPSM 拡張音源 (オリジナル 0.14 も非対応。検出された場合は
  警告を表示し、該当チャンネルはスキップします)

## ライセンス

GNU General Public License v2 or later — 詳細は `LICENSE` を参照してくだ
さい。本プロジェクトは NSF 再生コア
[NotSoFatso](third_party/NotSoFatso/README.md) (© 2004 Disch、FamiStudio
プロジェクトから同梱) をリンクしており、これは GPL-2+ です。

# miditrack

NES（`.nsf`/`.nsfe`）、SNES（`.spc`/`.spc2`/`.rsn`）、VGM（`.vgm`/`.vgz`）のチップチューンを編集可能なMIDIに変換し、ブラウザで試聴できます。一度セットアップすれば、普段の利用にターミナルは必要ありません。

`miditrack`はMac上だけで動作します。音源ファイル、MIDI、レンダリングした音声はすべてローカルに残ります。

## クイックスタート

1. Apple Silicon Macでこのリポジトリをcloneまたはダウンロードし、ディレクトリへ移動します。

   ```bash
   git clone https://github.com/Nihondo/miditrack.git
   cd miditrack
   ```

2. インストーラを実行します。Python、FluidSynth、Node.js、ffmpeg、Rubber Band、Python仮想環境、VGM実行時依存を導入します。

   ```bash
   ./install.sh
   ```

3. 試聴とWAV出力は、初期状態でFluidSynth標準のSoundFontを使えます。カスタムのGeneral MIDI SoundFont（`.sf2`/`.sf3`）を使う場合は、`soundfonts/`へ配置します。

   ```bash
   mkdir -p soundfonts
   cp /path/to/GeneralMIDI.sf2 soundfonts/
   ```

4. インストーラが`/opt/homebrew/bin/miditrack`を作成します。任意のディレクトリからアプリを起動できます。

   ```bash
   miditrack
   ```

5. 対応する音源ファイルまたは`.mid`ファイルをアップロード枠へ置き、編集・試聴してからMIDIまたはWAVをダウンロードします。

## できること

- NES、SNES、VGM/VGZの音源をMIDIへ変換します。複数曲を含むNSF/SPCでは曲を選べます。
- 複数の音源ファイル、`.zip`のリップパック、または音源と`.m3u`プレイリストをまとめてアップロードできます。プレイリストから曲名を取得できます。
- General MIDIの楽器を割り当て、トラック別の音量・ミュートを設定し、トラック一覧を並べ替え、よく使う楽器とアンサンブルプリセットをローカルに保存できます。
- 対応トラックでは**SoundFont**または**原曲の音源**を選べます。原曲の音源はゲーム由来のSoundFontまたはチップレンダラーを使い、SoundFontは選択したGMバンクを使います。
- 拡大可能なピアノロールでノートを確認し、再生位置・ループを指定し、色・テーマ・レイアウトを選び、全画面編集レイアウトへ切り替えられます。
- 曲全体の速度・ピッチを変更し、`.miditrack`プロジェクトを保存・再読込して、編集済みMIDIまたは高品質WAVをダウンロードできます。
- 速度・ピッチのバリエーションZIP、またはトラックごとにWAVを含むZIPを生成できます。

## ツール構成

| ツール | 役割 | 主な使い方 |
|---|---|---|
| **miditrack** | ブラウザでの変換、編集、試聴、出力 | 普段の利用に推奨 |
| **nsf2midi** | NES／ファミコンの`.nsf`/`.nsfe`をMIDIへ変換 | CLIから直接、またはmiditrackの変換 |
| **spc2midi** | SNESの`.spc`/`.spc2`/`.rsn`をMIDIと任意のゲーム用SoundFontへ変換 | CLIから直接、またはmiditrackの変換 |
| **vgm2midi** | VGM/VGZのコマンドログをMIDIへ変換 | CLIから直接、またはmiditrackの変換 |
| **miditrack/midi2wav.sh** | FluidSynthを使ってMIDIをWAVへ変換 | miditrackから使用、またはターミナルで直接実行 |

## 必要環境

- Apple Silicon Mac、[Homebrew](https://brew.sh/)、初回パッケージ取得用のインターネット接続
- `./install.sh`でPython 3.10以上、[FluidSynth](https://www.fluidsynth.org/)、Node.js、ffmpeg、Rubber Bandを導入し、必要なPython／Node.js環境を作成
- 初期状態ではFluidSynth標準のGeneral MIDI SoundFontを使います。カスタムの`.sf2`/`.sf3`を追加する場合は、`<リポジトリ>/soundfonts`（存在しなければ作成）または次の探索先へ配置します。
  - `<リポジトリ>/soundfonts`
  - `~/Library/Audio/Sounds/Banks`
  - `/opt/homebrew/share/soundfonts`
  - `/Library/Audio/Sounds/Banks`
  - `/opt/homebrew/share/fluid-synth/sf2`

インストーラはHomebrewの式を1件ずつ処理します。同名の式が別tapに存在して競合した場合も、Homebrewのエラーは表示したままセットアップを続行します。最後に必要なコマンドが`PATH`上で見つからない場合だけ停止します。

コンバーターのバイナリと、Apple Silicon向けVGM原曲音源のネイティブヘルパーは同梱されているため、通常の音源変換とVGM原曲音源にビルドは不要です。実音声ステムのミックス、トラック別出力、速度／ピッチ変更に必要なffmpegとRubber Bandも標準インストーラに含まれます。ヘルパーのソースを変更して再ビルドする場合だけ、CMakeとNinjaを導入してから`vgm2midi/scripts/build-native.sh`を実行してください。Intel MacではIntel版またはUniversal版のヘルパーバイナリが必要です。

## miditrackの使い方

### MIDIから始める場合

1. `.mid`/`.midi`ファイルをアップロードまたはドラッグします。
2. 各トラックの楽器、音量、ミュート状態と、表示される場合はSoundFontまたは原曲の音源を選びます。
3. SoundFontと**高速**（22.05kHz）または**品質**（44.1kHz）の試聴を選びます。品質はWAVダウンロードと同じ内容です。
4. 必要に応じて速度・移調を変更します。以降のすべてのレンダリングとダウンロードへ反映されます。
5. ピアノロールで確認、シーク、再生ループの範囲指定をします。表示設定は表示だけを変え、次回も保持されます。
6. MIDIまたはWAVをダウンロードします。WAVダウンロードは常に44.1kHzの品質レンダーを使います。

**プロジェクトを保存**すると、編集可能なMIDI、利用できる場合は音源と変換設定、トラック選択・速度／ピッチ・ファイル名・ループ・プリセットを含む保存済み編集状態を`.miditrack`アーカイブとしてダウンロードできます。**プロジェクトを開く**は、音源を再変換せずにその状態を復元します。レンダー済み音声と生成済みZIPは意図的にプロジェクトへ保存しません。

### 音源ファイルから始める場合

1. 音源ファイル1つ、複数ファイル、音源と`.m3u`、または`.zip`アーカイブをアップロードします。ZIPはファイル数200件まで、展開後合計512MiBまでに制限されます。
2. 変換可能な音源が複数ある場合はファイルを選び、形式が複数曲に対応する場合は曲を選びます。
3. 変換設定を選びます。
   - NSF: 秒数と任意のPALタイミング
   - SPC: ループ回数
   - VGM: ループ回数または秒数、加えて任意のOPN Ch3 Specialパーカッション変換
4. **原曲の音源を初期選択**は初期状態だけを決めます。変換後も対応トラックを切り替えられます。
5. **MIDIに変換**を選択してから、アップロードしたMIDIと同じように編集・出力します。

### SoundFontと原曲の音源

- **SoundFont**は、選択したGeneral MIDI SoundFontでMIDIを再生します。楽器変更も反映されます。
- **原曲の音源**は、SPCではゲーム由来のSoundFont、NSF/VGMではハードウェア／チップレンダリングを使います。これらのトラックでは楽器を選べませんが、音量は調整できます。
- VGMのルーティングは物理チップチャンネルに従います。ハードウェアチャンネルを共有する行はまとめて変わることがあり、曖昧な共有チャンネルを原曲の音源として自動選択することはありません。

### 出力オプション

- **バリエーションをまとめて生成**は、指定した速度×移調の全組み合わせをZIPにします。対応するMIDIも含められます。
- **トラックごとに出力**は、音があるトラックごとにWAVを作成します。原曲の音源チャンネルは1ファイルにまとめると、ハードウェアチャンネルごとのフルレンダリングを避けられます。
- バリエーション生成は速度6個、移調8個、組み合わせ合計15件までです。速度は0.1〜10倍、移調は−24〜+24半音に制限されます。MIDIの0〜127の範囲外へ移調されたノートは除外され、パーカッションは移調しません。

### 制限と挙動

- MIDIチャンネル10は楽器変更の対象外です。複数チャンネルにまたがるトラック（format 0 MIDIを含む）も編集できません。
- 試聴は音声をレンダリングしてから再生する方式で、ライブソフトウェアシンセではありません。完成済みレンダーは現在のセッションでキャッシュされ、編集後は短い待機時間をおいてプレビューを更新します。
- `.m3u`の曲名対応付けはベストエフォートです。古い、または対応付けできないプレイリストはエラーにせず、曲名を変えません。
- SoundFont、トラック編集、出力ファイル名の変更は、生成済みのバリエーションZIPとトラック別ZIPを無効にします。変更後に再生成してください。

### コマンドラインオプション

```text
miditrack [MIDI_FILE] [--soundfont FILE] [--no-browser]
```

| オプション | 説明 |
|---|---|
| `MIDI_FILE` | 起動時に読み込む任意の`.mid`/`.midi`ファイル。音源ファイルはブラウザからアップロードします。 |
| `-s, --soundfont FILE` | 起動時の既定SoundFont。ブラウザからいつでも変更できます。 |
| `--no-browser` | ブラウザタブを自動で開きません。 |
| `--version` | バージョンを表示して終了します。 |

## コマンドラインツールを使う

各コンバーターには完全なリファレンスがあります。ここでは一般的な例だけを示します。

### nsf2midi

```bash
nsf2midi song.nsf song.mid
nsf2midi -l song.nsf
```

MDF音色定義、PALタイミング、チップ音声レンダリングは[nsf2midi/README.md](nsf2midi/README_ja.md)を参照してください。

### spc2midi

```bash
spc2midi song.rsn song.mid
spc2midi -s 12 --sf2 song.rsn song.mid
```

SoundFont/DLS出力とループ処理は[spc2midi/README.md](spc2midi/README_ja.md)を参照してください。

### vgm2midi

```bash
vgm2midi song.vgz
vgm2midi song.vgz --loops 3
```

対応チップと高度なオプションは[vgm2midi/README.md](vgm2midi/README_ja.md)を参照してください。

### midi2wav.sh

```bash
./miditrack/midi2wav.sh song.mid
./miditrack/midi2wav.sh -S song.mid
./miditrack/midi2wav.sh -s MySound.sf2 -f song.mid
```

## トラブルシューティング

- **SoundFontが見つからない**: `--soundfont`を指定する、`MIDI2WAV_SOUNDFONT`を設定する、または上記のいずれかのディレクトリへ`.sf2`/`.sf3`を配置します。
- **midi2wavが見つからない**: `brew install fluid-synth`でFluidSynthをインストールします。
- **同梱コンバーターが見つからない**: リポジトリ内の元の場所へ戻すか、`NSF2MIDI_BIN`、`SPC2MIDI_BIN`、`VGM2MIDI_BIN`を設定します。
- **対応するSNESドライバが見つからない**: そのSPCドライバは対応するVGMTransのファミリーではないため、変換できません。
- **変換可能な音源ファイルが見つからない**: アップロードまたはZIPに対応する音源ファイルが含まれていません。
- **ZIPファイルが不正**: アーカイブが破損しているか、ZIPではありません。
- **miditrackにはFlaskが必要**: クイックスタートの手順で`.venv`を作り直します。
- **rubberbandが見つからない**: 実音声ステムへ既定値以外の速度・ピッチを適用する前に、`brew install rubberband`でインストールします。

## 謝辞

- [NotSoFatso](https://github.com/BleuBleu/FamiStudio)は、同梱するNES／ファミコン再生コアの基盤です。
- オリジナルの`nsf2midi.exe` 0.14は、このmacOS再実装とMDF形式互換の着想元です。
- [VGMTrans](https://github.com/vgmtrans/vgmtrans)は、`spc2midi`が使うSNESシーケンスパーサーを提供します。
- [jkarenko/vgm2midi](https://github.com/jkarenko/vgm2midi)は、`vgm2midi`の上流フォークです。
- [FluidSynth](https://www.fluidsynth.org/)は、SoundFont音声をレンダリングします。
- [Rubber Band Library](https://breakfastquay.com/rubberband/)は、速度・ピッチ変更後の実音声ステムを同期します。
- [DSEG](https://github.com/keshikan/DSEG)は、同梱する再生タイマー用Webフォントを提供します。

## ライセンス

| ツール | ライセンス |
|---|---|
| miditrack | MIT |
| nsf2midi | GPL-2.0-or-later |
| spc2midi | zlib（VGMTransのLGPL-3.0コンポーネントを含む） |
| vgm2midi | MIT |

完全なライセンスと帰属は、各サブプロジェクトの`README.md`、`LICENSE`、`NOTICE.md`を参照してください。

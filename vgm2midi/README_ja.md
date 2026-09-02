# vgm2midi

VGM/VGZ（ビデオゲームミュージックのコマンドログ）ファイルを、記録されているサウンドチップへのレジスタ書き込みを再生してノートオン/オフ・ピッチ・ベロシティを推定することでStandard MIDI Fileに変換する、Node.js/TypeScript製のコマンドラインツールです。macOS、Linux、Windowsで動作します。

これは[jkarenko/vgm2midi](https://github.com/jkarenko/vgm2midi)をベースに、HuC6280（PCエンジン/TurboGrafx-16のPSG）変換、実際に動作するYM2151（アーケードFM音源）変換、YM2203（OPN）変換、YM2608（OPNA）変換、YM2413（OPLL）変換、YM3526/YM3812/Y8950（OPL）変換、Game Boy DMG（LR35902 APU）変換を追加し、さらにOPNチャンネル3特殊モード、YM2612 DAC、SegaPCM/C140のサンプルトリガー抽出を追加したローカルフォークです。由来については`NOTICE.md`、変更内容と理由については`CLAUDE.md`を参照してください。

## 機能

- VGMおよびVGZ（gzip圧縮されたVGM）ファイルをStandard MIDI Fileに変換
- 以下のサウンドチップに対応:
  - SN76489 PSG（セガ・マスターシステム、ゲームギア、メガドライブ）
  - YM2612 FMおよびDACサンプル（メガドライブ）
  - YM2203 OPN: 3チャンネルFM＋3チャンネルSSG（PC-88/PC-98、FM-7、アーケード基板）— このフォークで追加
  - YM2608 OPNA: 6チャンネルFM＋3チャンネルSSG＋6内蔵リズム音色＋ADPCM-B（PC-88/PC-98）— このフォークで追加
  - YM3526/YM3812/Y8950 OPL: 9チャンネルFM＋5音リズムモード（アーケード、DOS AdLib、MSX-AUDIO）— このフォークで追加。Y8950 ADPCMは診断のみ
  - YM2151 FM（アーケード基板）— このフォークで完成
  - AY-3-8910 PSG（MSX、Amstrad CPC、ZX Spectrum）
  - HuC6280 PSG（PCエンジン/TurboGrafx-16）— このフォークで追加
  - SegaPCM（セガ・アーケードPCM）— このフォークでサンプルトリガー抽出を追加
  - C140 PCM（ナムコ・アーケードシステム）— このフォークでサンプルトリガー抽出を追加
  - YM2413 OPLL: 9チャンネルFM＋5音リズムモード（セガ・マスターシステムFM Sound Unit、MSX-MUSIC）— このフォークで追加
  - Game Boy DMG（LR35902 APU）: 矩形波2ch＋波形1ch＋ノイズ1ch — このフォークで追加
- SN76489、YM2151、YM2203/YM2608 SSG、AY-3-8910、HuC6280、Game Boy DMGのハードウェアノイズによるリズムを、MIDIチャンネル10の独立したGMパーカッショントラックへ変換（多くはノート42のClosed Hi-Hat、一部のチップは高/中/低の3バンドへ振り分け）
- HuC6280ノイズの発音中に音量が4段階以上上昇した場合はパーカッションを再トリガーし、ソフトウェアエンベロープによる反復ハイハットのアタックを保持
- YM2608内蔵リズムの6音色をGM Bass Drum、Snare Drum、Crash Cymbal、Closed Hi-Hat、Low Tom、Side Stickへ割り当て、キーマスク、再トリガー、音量変化を保持
- YM2413内蔵の5リズム音色（Bass Drum、Hi-Hat、Snare Drum、Tom-Tom、Top Cymbal）を、それぞれ独立してトリガーされるGMパーカッションノートへ変換
- OPLファミリの5リズム音色を同じGMパーカッションへ割り当て、`$BD`の未変化キービットを再トリガーせず遷移だけを保持
- YM2203／YM2608／YM2612チャンネル3のスペシャルモードを、既定では編集可能な4本のオペレータ別ピッチトラックへ変換。`--ch3-special-percussion`指定時は、FM複合音の各アタックをGMのBass Drum、Snare、Hi-Hat、Crash、または音程別Tomの1打へ畳み込み
- YM2612の旋律チャンネル6をMIDIチャンネル14へ割り当て、General MIDIで予約されたパーカッション用チャンネル10との衝突を回避
- YM2612 DAC、YM2608 ADPCM-B、SegaPCM、C140の異なるサンプルIDごとに独立したGMパーカッショントラックへ変換し、最初の47種類へ初出順でノート35〜81を割り当てる。GMノート範囲が循環した後も、`--track-metadata`は循環しないサンプルID、割当先GMノート、開始／停止境界を保持する
- 対応するVGM data blockがある場合、`--track-metadata`はYM2612 DAC、MSM6258、YM2608 ADPCM-BのROMモード、SegaPCM、C140のトリガーをbank/blockとoffsetへ関連付ける。ROM参照には宣言されたROM size、ロード開始アドレス、payload長を含めるが、サンプル音声はデコードしない
- SegaPCMとC140の開始イベントには、排他的な終了アドレス、ループアドレス、ループ有効状態も保持する。再生速度とチップ動作が固有であるため、これらの値からMIDIノートオフ時刻は推定しない
- C140のROM参照と範囲アドレスは、VGM headerのC140 type 0（System 2）、1（System 21）、2（NA-1/NA-2のC219）に従って変換する。未定義のtypeはSystem 2アドレスとして扱う
- 非ループで範囲と周波数が有効なC140/C219トリガーでは、`--track-metadata`に概算の`durationSamples`を記録する。この値はsidecar専用であり、MIDI Note Offを自動配置しない。C219のノイズモードには有限長の推定を行わない
- SegaPCMはVGM interface registerのbank shiftとbank maskからサンプルの物理ROMアドレスを求め、data block参照、サンプルID、終了位置、ループ位置に同じ物理アドレスを用いる。非ループ発音では、16.8アドレス、終了ページ、周波数、クロック分周から概算の`durationSamples`も記録する。この値はsidecar専用であり、ループ発音には有限長の推定を行わない
- SegaPCMのサンプル範囲が単一ROM data block内に完全に存在する場合、`--track-metadata`は符号付き8-bit PCMの正規化ピーク、平均、RMS、ゼロクロス数も出力する。範囲が不完全またはblockをまたぐ場合は省略し、楽器名を推定しない
- C219も、検証済みの生の符号付き8-bit PCMモードに限り同じ統計値を出力する。μ-law、ノイズ、符号反転、未検証mode bit、不完全またはblockをまたぐ範囲は省略する
- 非repeatのYM2608 ADPCM-Bトリガーでも、有効な範囲、Delta-N、クロックから概算の`durationSamples`を記録する。ROM/8-bit RAMは32 byte、1-bit RAMは4 byteのアドレス単位を用い、repeat状態は`isLoop`として保持する。いずれもsidecar専用であり、MIDI Note Offを自動配置しない
- 完全に解決できるYM2608 ADPCM-B ROM範囲、C140の12-bit／圧縮PCM範囲、C219の生PCM／μ-law範囲は、復号後の波形統計と説明的な`timbre`ラベル（`quiet`、`tonal`、`noise-like`）を出力する。MIDIイベントやGM割当は変更せず、意味的な楽器名を主張しない
- 発音中のYM2203/YM2608/YM2612アルゴリズム経路に、明示的に書き込まれた明確な2の累乗の共通オペレータ倍率がある場合、`MULTI=0`の実効0.5倍を含めてノートをオクターブ単位で補正。補正値はキーオン時に固定するため、キーオフ直前の音色設定による瞬間的な余分なノートを防止
- SN76489およびAY/YM2149のクロック分周・periodフラグを反映し、チップ種別・dual-chipビットをクロック値から除外。dual AY8910/HuC6280は別々のMIDIトラックへ変換
- HuC6280の分割周波数レジスタ書き込みは最大1フレーム（50 Hz）までを結合し、それより後の無関係な書き込みとは分離
- YM2151/YM2203/YM2608/OPL FMの各ノート境界をチップのハードウェアキーオン/キーオフ書き込みに合わせ、発音中のYM2151キーコード/キーフラクションまたはOPN/OPL F-Number変更をピッチベンドへ変換。ソフトウェア音程エンベロープやアルペジオによるフレーム単位のノート再トリガーを防止
- すべての旋律ノートの発音開始時にピッチベンドを適用し、元周波数を最大半音の半分ずれた丸め値のままにせず保持
- 旋律トラックへ明示的にGeneral MIDI音色を送信し、DAW側でランダムな既定音色が割り当てられることを防ぐ。PSGと波形音源は「Lead 1 (square)」を使う。OPN/OPMとOPLのFMトラックは最初のノート時点のアルゴリズムから安定したGM音色候補を選ぶ。この候補は試聴用であり、元のFM音色を再現するものではない
- テンポ指定
- VGMのループ区間を合計再生回数（`--loops`）または正確な目標再生時間（`--duration`）まで展開
- 詳細モードで検出チップと変換統計を表示
- MIDI音符を生成できない場合は成功扱いや出力の上書きをせず、14バイトの空MIDIヘッダーを作る代わりにエラー終了
- `--noise-wav FILE`でSN76489/HuC6280ノイズを16bit・44.1kHz・ステレオの独立したLFSRステムへレンダリングし、対応するGMパーカッションノートを既定で抑制。A/B比較では`--keep-noise-midi`を追加可能
- `--dac-wav FILE`で実際のYM2612 DAC/PCMサンプル音声（メガドライブのドラムチャンネル）を16bit・44.1kHz・ステレオの独立したステムへレンダリングし、対応するGMパーカッションノートを既定で抑制。A/B比較では`--keep-dac-midi`を追加可能
- `--track-metadata FILE`で、出力MIDIの各トラック番号とlibvgmのdevice／instance／main・linkedチャンネルマスクを対応付けたversioned JSON sidecarを書き出す。FMトラックには最初のノート時点の音源モデル、アルゴリズム、carrier、オペレータレベル、倍率、キーオンマスク、GM音色候補を出力する。YM2413は選択patchから初期候補を選ぶ。`fmEvents`には発音中のpatch/user patch変更に加え、OPN/OPM/OPLのアルゴリズム、オペレータMULTIPLE、Total Level変更を記録する。OPN Ch3 SpecialトラックにはSpecialまたはSpecial+CSM状態も記録する。PCMトラックには音源固有のサンプルID、割当先GMノート、開始／停止境界とMSM6258のループ境界を出力する。YM2612 DAC、MSM6258、YM2608 ADPCM-BのROMモード、SegaPCM、C140は、該当するVGM data blockの範囲も記録する。ROM参照には物理サンプルアドレス、宣言されたROM size、blockのロード開始アドレス、payload長を含める。YM2608 ADPCM-B開始イベントにはrepeat状態と、有限再生時の概算長も記録する。SegaPCM開始イベントにはinterface変換後の物理ROMアドレスを用いる。SegaPCMとC140の開始イベントには排他的な終了アドレス、ループアドレス、ループ有効状態も記録する。MSM6258開始イベントには要求byte長と、解決できる場合の再生予定長を記録する。既存のチャンネル対応を使う`miditrack`との互換性は維持する

`--track-metadata`では、完全に解決できるSegaPCM範囲と検証済みC219生8-bit PCM範囲に基礎波形特徴も記録します。C219のμ-law、ノイズ、符号反転、未検証mode bit、および不完全またはblockをまたぐ範囲は記録しません。

## インストール

このリポジトリから使用します。

```bash
cd vgm2midi
npm install
npm run build
```

ビルド済みの`dist/`は既にコミットされているため、ソースを編集した場合のみこの手順が必要です。以下で直接実行できます。

```bash
node vgm2midi/dist/cli.js <input> [options]
```

`npm install -g vgm2midi`でインストール済みのグローバルコマンド`vgm2midi`を、無修正のオリジナル版ではなくこのフォークに向けたい場合は、このディレクトリで`npm link`を実行してください。

## 使い方

```bash
vgm2midi input.vgm
```

同じディレクトリに`input.mid`が生成されます。VGZ（gzip圧縮されたVGM）ファイルは自動的に検出・解凍されます。

### オプション

```
Usage: vgm2midi [options] <input>

Arguments:
  input                   Input VGM or VGZ file

Options:
  -V, --version          output the version number
  -o, --output <file>    Output MIDI file (default: input filename with .mid extension)
  -t, --tempo <bpm>      MIDI tempo in BPM (default: "120")
  --loops <count>        Total loop-section playback count, including the logged pass
  --duration <seconds>   Target output duration in seconds
  -v, --verbose          Verbose output
  --noise-wav <file>     Render SN76489/HuC6280 hardware noise to a separate WAV stem
  --keep-noise-midi      Keep GM percussion notes when --noise-wav is used
  --dac-wav <file>       Render YM2612 DAC/PCM sample audio to a separate WAV stem
  --keep-dac-midi        Keep GM percussion notes when --dac-wav is used
  --ch3-special-percussion
                         Collapse OPN Ch3 Special composite hits to GM percussion
  --strict               Fail before output when parsed content would be omitted
  --split-chips          Also write collision-free chip/instance MIDI sidecars
  --stems <directory>    Render sample-exact libvgm mix/chip WAV stems and manifest
  --track-metadata <file>
                         Write MIDI-track to libvgm channel mapping JSON
  -h, --help             display help for command
```

`-v`を付けると、VGMバージョン、再生時間、ヘッダから検出されたサウンドチップ、解析済み総コマンド数が表示されます。長い変換を待つ前に、入力ファイルが正しく認識されているか確認するのに便利です。変換成功時は、必ず音符を含むMIDIトラックが1つ以上作られます。未対応音源や非音程データだけの入力は、空MIDIを書き出さずエラー終了します。

`--loops`と`--duration`は同時に指定できません。`--loops 1`はデフォルトの1回分の出力を維持します。たとえば`--loops 3`ではイントロを1回だけ保持し、VGMに記録済みの1回を含めてループ区間を合計3回再生します。`--duration 600`では必要な回数だけループし、最後のVGMウェイトを正確に600秒で切り詰めます。ループ位置を持たないVGMは`--duration`で短くできますが、元データより長くしたり、`--loops 2`以上を指定したりすることはできません。

`--noise-wav noise.wav`は、実際に発音するSN76489/HuC6280ノイズだけをMIDI出力と同じ時間軸の独立WAVへ書き出します。2つをミックスした際にパーカッションが二重発音しないよう、対応するチャンネル10のドラムノートはMIDIから除外されます。比較のため意図的に両方を残す場合だけ`--keep-noise-midi`を使います。このステムレンダラは各チップのLFSRノイズ経路専用で、完全なチップエミュレータではありません。トーン、FM、HuC6280 DDA/PCM、バランスレジスタはレンダリングしません。

`--dac-wav dac.wav`は、実際のYM2612 DAC/PCMサンプル音声（メガドライブのゲームはこのチャンネルをサンプリングされたドラムによく使います）を、プレースホルダーのGMノートではなくVGMから取得した実際のサンプルバイトを使ってMIDI出力と同じ時間軸の独立WAVへ書き出します。対応する`YM2612 DAC Sample`/`YM2612 DAC Direct`のチャンネル10トラックは既定でMIDIから除外され、2つの出力をミックスしてもパーカッションが二重発音しません。比較のため意図的に両方を残す場合だけ`--keep-dac-midi`を使います。

`--ch3-special-percussion`は、YM2203、YM2608、またはYM2612のチャンネル3スペシャルモードをFMの複合ドラム音として使う曲向けです。これらのOPN系チップでは、スペシャルモードでも各オペレータが選択中のFMアルゴリズムで合成されるため、このオプションは4本の無関係な音程ノートではなく、ハードウェア上の各アタックをMIDIチャンネル10の1打として出力します。可聴キャリアの基準音域からBass Drum、Snare、Closed Hi-Hat、Crash Cymbal、または6段階のTomへ振り分けます。これは実用的なGM近似であり、元のFM音色を再合成するものではありません。チャンネル3を旋律的に使う曲でオペレータ別ピッチを編集したい場合は、このオプションを指定しないでください。dual YM2203／YM2608はインスタンスごとに独立して追跡されます。

### 忠実度・診断・ステム

MIDIタイミングは絶対VGMサンプル位置から導く960 PPQです。`--strict`は未対応書き込みが省略される場合、出力前にエラーにします。指定しない場合は警告を表示して継続します。`--split-chips`は通常MIDIを保持したまま、`song.YM2151.mid`や`song.YM2203-2.mid`のような衝突しないsidecarを作成します。

SN76489、YM2413、YM2612、YM2151、YM2203、YM2608、YM3526、YM3812、Y8950、AY8910、Game Boy DMG、SegaPCM、C140、HuC6280はdual instanceを解析します。PCM stream device 0x17（MSM6258/OKIM6258）はbank/start/lengthで識別する安定したGM編集トリガーであり、音色分類ではありません。`--stems DIR`は同梱のpin済みarm64 libvgm helperを使い、44.1 kHz・16-bit stereoのmix/チップ別WAVと`*.stems.json`を作ります。ソースを変更した場合だけ、チェックアウト外で`vgm2midi/scripts/build-native.sh`（commit `57585ea`）を実行して再ビルドしてください。source/cache/buildの既定位置はすべて`/tmp`です。`VGM2MIDI_NATIVE_CACHE`、`VGM2MIDI_LIBVGM_SOURCE`、`VGM2MIDI_NATIVE_BUILD`で変更できますが、いずれもチェックアウト外を指定してください。helperはpin済みのlocal git objectがあればネットワークへ接続せず再利用し、存在しない場合だけ取得します。`VGM2MIDI_NATIVE_OFFLINE=1`はsource cacheが無い場合にclone/fetchより先に拒否し、cache済みcheckoutにpinが無い場合も拒否します。`npm run verify:native-stems`で再ビルド後、mix/stemのsample数・加算RMSと、`miditrack`が使うチャンネルマスク選択モードを検証できます。`--track-metadata FILE`はMIDIトラック番号とlibvgmのdevice／instance／main・linkedチャンネルマスク、および保守的な実機ミックス推奨フラグを持つversioned JSON sidecarを書き出します。

内部のトラック識別子は`{chip, instance, section, channel, sourceKey, midiChannel}`です。従ってregister/latch/DAC/PCM/rhythm/key/TL/pan stateはEOFでのnote closeを含め、dual deviceごとに独立します。通常MIDIが警告するのは異なるdescriptorが同じMIDI channelで実際に重なる場合だけです。`--split-chips`は常にdescriptor由来のsidecarを出力します。

parserはVGM 1.72の全chip writeを保持します。未対応writeは`unsupported_write` commandとなり、`VGMParser.parse().diagnostics`からchip/instanceごとのmask済みclock、command/write/stream count、MIDI supportを取得できます。例:

```json
{"chips":[{"chip":"MSM6258","instance":0,"clock":4000000,"commandCount":3,"writeCount":0,"streamCount":1,"midiSupport":"trigger"}],"unsupportedWriteCount":1,"hasOmittedContent":true}
```

既定CLIは`YMF262 (writes 1, streams 0)`のようにchip名付きで警告して継続し、`--strict`はMIDI出力前に失敗します。legacy VGM 1.00/1.01のFM clock所有者はSN clockを推測せず、境界どおり最初のYM2413/YM2612/YM2151 writeから決定します。

YM2151、OPN、OPLのcarrier TLはkey-on時のvelocityと発音中のCC11を制御します。OPLの`$Bx` key-onは遷移ガード式で、bit 5を立てたままの反復pitch writeは新しいattackではなく±96半音pitch bendになります。YM2413は`$10` LSBより先に`$20` key-onが来た場合に確定を遅らせ、明示的な2の累乗carrier Multiple補正だけを適用します。PSG/SSG/HuCの周波数変更は実gate restart以外では±96半音pitch bendによる1 noteに保ちます。Game Boyの絶対sample時刻に基づく512 Hz frame sequencerはlength note-off、envelope CC11、channel 1 sweep bendを出力します。panはFM、Game Gear `$4F`/second `$3F`、AY/SSG `$31`、HuC6280、Game Boy NR50/NR51でCC10（`left=0`、`both=64`、`right=127`）です。

すべての`0x67` data blockはbank type・instance・block IDごとに保持します。size fieldのbit 31は第二bank instanceを選び、compressed `0x40`～`0x7E` blockはVGM compression header（`0x7F` tableを含む）に従って展開してから`0x95`で検索します。不正なcompressed blockはcommand streamをずらさず安全に失敗します。stream `0x91` step dataと`0x93` length modeからMSM6258 trigger durationを決めます。mode `0`は前回解決したlengthを維持するDCTRL_LMODE_IGNORE、`1`はcommands、`2`はmilliseconds、`3`はbank終端まで、`0x0F`はraw bytesです。non-loopのnatural endは確定時まで保留するため、`$94`またはrestartで短縮・置換できます。loop streamは`$94`または変換終端までopenです。このMIDIは編集用markerだけであり、可聴音源はlibvgm MSM6258 stemです。

native manifestは、input basenameまたはoutput directoryにquote・backslash・control characterが含まれても有効なUTF-8 JSONです。offline modeの`VGM2MIDI_NATIVE_OFFLINE=1`は、source cacheが無い場合にclone/fetchより先に拒否し、cache済みcheckoutにpin `57585ea`が無い場合も拒否します。

corpus auditは読み取り専用で、corpusファイルを展開・変更しません。direct VGM/VGZとZIP archive内のVGM/VGZ entryをメモリ上で解析し、diagnostics、zero-note conversion、MSM6258 trigger候補を集計します。`VGM2MIDI_CORPUS_ROOT=/path npm run audit:corpus`を実行してください。正規collectionを監査する場合は`VGM2MIDI_EXPECTED_SONGS=133`を設定します。ZIP検査にはsystemの`unzip`コマンドが必要です。

### 実行例

```bash
vgm2midi song.vgz -o song.mid -v
vgm2midi "01 Magical Sound Shower.vgm" --tempo 140
vgm2midi song.vgz --loops 3
vgm2midi song.vgz --duration 600
vgm2midi song.vgz --noise-wav song.noise.wav
vgm2midi song.vgz --dac-wav song.dac.wav
vgm2midi song.vgz --ch3-special-percussion
```

## 動作の仕組み

1. VGMヘッダ（各チップのクロック周波数、データ開始オフセット、サンプル数）を解析。入力がVGZの場合は先に解凍
2. VGMのループ位置を解決し、`--loops`または`--duration`が指定された場合はコマンドのタイムラインを展開または切り詰め
3. コマンド列を走査し、書き込みを再生しながら各チップ・各チャンネルの周波数・音量・有効状態・対応PCMサンプルIDを追跡
4. 周波数をMIDIノート番号に変換（`note = 69 + 12 * log2(freq / 440)`）、またはYM2151のキーコード/キーフラクションを直接解読し、各チップの有効化/音量の意味からノートオン/オフを推定して、対応するハードウェアノイズをGMパーカッションへ振り分け
5. Standard MIDI Fileを書き出し（エミュレートしたチップチャンネルごとに1トラック）

### 制限事項

- FM音源のパラメータは簡略化されています — MIDIにはFM音色のネイティブなモデルが無いため、YM2203/YM2608/YM2612/YM2151のチャンネルは単純なノートとして近似されます。YM2203、YM2608、YM2612では、アルゴリズム、キーオンマスク、トータルレベル、明示的に書き込まれたオペレータ倍率を、0.5倍を含む明確な2の累乗の共通オクターブ補正にのみ使用します。共通する2の累乗倍率を持たない比率、デチューン、エンベロープ、聴感上のミッシングファンダメンタルは、従来どおり生のF-Numberによる近似のままです
- YM2413は逆順の`$20`→`$10` key-onを遅延確定し、明示的な2の累乗carrier Multiple補正だけを扱います。2の累乗以外の比率、envelope、detune、元のOPLL音色はMIDIのモデル外です。patchから選ぶGM音色候補は試聴用であり、音色再現ではありません
- YM3526/YM3812/Y8950 OPL変換はF-Number/block、key遷移、CNT carrier経路、Total Level、MULTIPLEによるオクターブ補正、`$BD`リズムキーを扱います。KSL、feedback、波形選択、envelope、AM/vibrato、元のFM音色は再現しません。YMF262/OPL3とY8950 ADPCMは変換対象外で、Y8950 ADPCM writeはdiagnosticsと`--strict`に残ります
- YM2203／YM2608／YM2612チャンネル3のスペシャルモードは、オペレータ別の`$A8-$AA`／`$AC-$AE`周波数と、オペレータ4が使う通常の`$A2`／`$A6`周波数から変換します。既定の4トラック出力は編集用に各オペレータ周波数を露出しますが、アルゴリズム内のFM相互作用は再現できません。`--ch3-special-percussion`は複合アタックを1打に保ち、キャリアの基準音域からGMドラムへヒューリスティックに割り当てますが、元のFM音色は合成せず、特殊な音色を誤分類する可能性があります
- `fmEvents`は編集用sidecarであり、発音中のFMトラックで変更された音色レジスタだけを記録します。オペレータエンベロープ、デチューン、feedback、LFO、元のFM音色をMIDI自動化として再現するものではありません
- PCM data blockメタデータはエンコード済みの元byte位置を示すだけで、ADPCM/PCMを楽器名へ分類したり、GMドラム種別を断定したりするものではありません
- CSMモードはYM2612、YM2151、YM2203、YM2608で変換します。Timer Aのオーバーフローを1 tickのMIDIアタックへ変換します。OPNは既存のCh3 Special表現を使い、OPMは設定済みの8チャンネルをアタックします。同一MIDI tick内の複数オーバーフローは1回へ集約するため、元のFMエンベロープを再現するのではなく、編集可能なアタック近似として出力します
- YM2151/YM2203/YM2608/OPL FMトラックは、発音中の大きなキーコード/キーフラクションまたはF-Number変化を連続して保持するため、MIDI RPN 0で±96半音のピッチベンドレンジを宣言します。ピッチベンドレンジのRPNメッセージを無視するMIDIプレーヤーでは、ベンド幅が正しく再生されません
- SN76489、YM2151、YM2203/YM2608 SSG、AY-3-8910、HuC6280、Game Boy DMGのハードウェアノイズはGMドラムノートとして近似されます（多くはClosed Hi-Hat、一部のチップは高/中/低の3バンド）。チップ固有のノイズ音色は再現されません
- Game Boy DMGは512 Hz frame sequencerによるchannel 1 sweep、length counter、envelope CC11を扱います。wave RAMの内容、従って元の音色はMIDIのモデル外です
- YM2612 DAC、YM2608 ADPCM-B、SegaPCM、C140のサンプル音声は音色分類を行いません。完全に解決できるSegaPCM範囲と検証済みC219生PCM範囲は基礎統計だけを出力し、ADPCM、C140の12-bit PCM／圧縮PCM、C219 μ-lawのデコードや音色ラベルは行いません。割り当てたGMノートはサンプルIDを区別するためのもので、キック、スネア、ハイハットなど対応するGM楽器の意味を保証しません。48種類目以降の割り当ては循環します。YM2612のシーク後にDAC出力が続く場合は発音開始として扱うため、無音やサンプル途中の継続だけを目的としたシークでも余分なパーカッションが生成される可能性があります
- YM2608 ADPCM-Bはrepeat状態を保持し、Delta-N、範囲、クロックから有限再生の長さをsidecarへ概算記録します。Delta-NのMIDI音程、サンプル音声のデコード、概算値によるMIDI Note Offは再構築しません。開始アドレスでサンプルトリガートラックを識別し、次の開始/リセットまたは変換終了時にMIDIノートを閉じます
- HuC6280のDirect D/Aモード（生波形のサンプル再生）はノートに変換されません
- どのチップについてもステレオパンとLFO/ビブラートはモデル化されていません
- 複数のチップ系統にまたがって13チャンネルを超える同時発音がある場合、MIDIチャンネルの割り当てがラップして衝突することがあります（同一VGM内で複数のチップ系統を同時に鳴らす場合のみ関係します。詳細は`CLAUDE.md`を参照）

## VGMファイルフォーマットについて

VGMは、ゲームプレイ中にサウンドチップへ送られた正確なコマンドを記録する、サンプル精度のロギングフォーマットです。詳細は[VGM specification](https://vgmrips.net/wiki/VGM_Specification)を参照してください。

## ライセンス

MIT — `LICENSE`を参照。このフォークの元になったプロジェクトについては`NOTICE.md`を参照してください。

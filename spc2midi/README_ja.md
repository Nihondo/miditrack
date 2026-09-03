# spc2midi

`spc2midi`はスーパーファミコンの`.spc`／`.spc2`をStandard MIDI File（`.mid`）へ変換します。元の音色をSoundFont2（`.sf2`）またはDLS（`.dls`）として出力することもできます。エミュレーションではなく、[VGMTrans](https://github.com/vgmtrans/vgmtrans)のシーケンスパーサーを使います。

## 対応入力

- `.spc`と`.spc2`を自動判別して変換します。
- `.rsn`は意図的に未対応です。`RSNLoader`と`unarr`は、開発・テスト・配布を含むすべてのビルドから除外しています。
- このCLIはZIPを直接入力しません。miditrack本体はZIPを受け付け、安全なZIP制限の範囲で中の`.spc`／`.spc2`を選択して変換します。

## ビルド

コミット済みのarm64バイナリは、固定VGMTransパッチで再ビルドします。

```bash
brew install cmake ninja
./build.sh
```

初回ビルドではVGMTransを`~/.cache/spc2midi/`へ取得します。`patches/vgmtrans-no-rsn.patch`は`RSNLoader.cpp`、`lib/unarr`、そのincludeとリンク依存を除外します。再ビルド後は次で確認できます。

```bash
nm -gU spc2midi | rg 'ar_open_rar_archive' && exit 1 || true
otool -L spc2midi
```

## 使い方

```text
spc2midi [options] <input.spc> [output.mid]
```

拡張子は信頼せず、VGMTransが対応SPCデータを自動判別します。

| オプション | 説明 |
|---|---|
| `-l, --list` | 検出したシーケンスを一覧して終了 |
| `-s, --seq <n>` | 0始まりのシーケンスを変換（既定: `0`） |
| `-a, --all` | 検出した全シーケンスを出力ディレクトリへ変換 |
| `--loops <n>` | 無限ループを展開する回数（既定: `1`） |
| `--sf2` / `--dls` | SoundFont2またはDLSも出力 |
| `-v, --verbose` | VGMTransのログを表示 |
| `-h, --help` | 使い方を表示 |

例:

```bash
spc2midi song.spc song.mid
spc2midi --sf2 song.spc song.mid
mkdir out && spc2midi -a game.spc out
```

## ライセンス

spc2midiとVGMTransはzlibライセンスです。現在の静的リンク依存の一覧は`LICENSE`と`NOTICE.md`を参照してください。

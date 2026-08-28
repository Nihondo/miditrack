"""General MIDI Level 1 の128音色名と16ファミリーの唯一のソース。

このリポジトリの他のどこにも128音色フルの名前テーブルは存在しない
（nsf2midi/vgm2midi はGMプログラム番号を扱うが、名前の一覧までは持っていない）。
JS側にも重複させず、/api/instruments を通じてこのモジュールの内容だけを配信する。
"""

from __future__ import annotations

PROGRAMS_PER_FAMILY = 8
# SPCの原曲音源からGM SoundFontへ初めて切り替える際の安全な既定音色。
DEFAULT_GM_PROGRAM = 80  # GM 81: Lead 1 (square)

# 各ファミリーはGMプログラム番号の連続する8個のブロックに対応する
# （0-7=Piano, 8-15=Chromatic Percussion, ... 120-127=Sound Effects）。
GM_FAMILY_NAMES: tuple[str, ...] = (
    "Piano",
    "Chromatic Percussion",
    "Organ",
    "Guitar",
    "Bass",
    "Strings",
    "Ensemble",
    "Brass",
    "Reed",
    "Pipe",
    "Synth Lead",
    "Synth Pad",
    "Synth Effects",
    "Ethnic",
    "Percussive",
    "Sound Effects",
)

# GM1標準の128プログラム名（0始まりのプログラム番号順）。
GM_PROGRAM_NAMES: tuple[str, ...] = (
    # 0-7 Piano
    "Acoustic Grand Piano",
    "Bright Acoustic Piano",
    "Electric Grand Piano",
    "Honky-tonk Piano",
    "Electric Piano 1",
    "Electric Piano 2",
    "Harpsichord",
    "Clavi",
    # 8-15 Chromatic Percussion
    "Celesta",
    "Glockenspiel",
    "Music Box",
    "Vibraphone",
    "Marimba",
    "Xylophone",
    "Tubular Bells",
    "Dulcimer",
    # 16-23 Organ
    "Drawbar Organ",
    "Percussive Organ",
    "Rock Organ",
    "Church Organ",
    "Reed Organ",
    "Accordion",
    "Harmonica",
    "Tango Accordion",
    # 24-31 Guitar
    "Acoustic Guitar (nylon)",
    "Acoustic Guitar (steel)",
    "Electric Guitar (jazz)",
    "Electric Guitar (clean)",
    "Electric Guitar (muted)",
    "Overdriven Guitar",
    "Distortion Guitar",
    "Guitar Harmonics",
    # 32-39 Bass
    "Acoustic Bass",
    "Electric Bass (finger)",
    "Electric Bass (pick)",
    "Fretless Bass",
    "Slap Bass 1",
    "Slap Bass 2",
    "Synth Bass 1",
    "Synth Bass 2",
    # 40-47 Strings
    "Violin",
    "Viola",
    "Cello",
    "Contrabass",
    "Tremolo Strings",
    "Pizzicato Strings",
    "Orchestral Harp",
    "Timpani",
    # 48-55 Ensemble
    "String Ensemble 1",
    "String Ensemble 2",
    "Synth Strings 1",
    "Synth Strings 2",
    "Choir Aahs",
    "Voice Oohs",
    "Synth Voice",
    "Orchestra Hit",
    # 56-63 Brass
    "Trumpet",
    "Trombone",
    "Tuba",
    "Muted Trumpet",
    "French Horn",
    "Brass Section",
    "Synth Brass 1",
    "Synth Brass 2",
    # 64-71 Reed
    "Soprano Sax",
    "Alto Sax",
    "Tenor Sax",
    "Baritone Sax",
    "Oboe",
    "English Horn",
    "Bassoon",
    "Clarinet",
    # 72-79 Pipe
    "Piccolo",
    "Flute",
    "Recorder",
    "Pan Flute",
    "Blown Bottle",
    "Shakuhachi",
    "Whistle",
    "Ocarina",
    # 80-87 Synth Lead
    "Lead 1 (square)",
    "Lead 2 (sawtooth)",
    "Lead 3 (calliope)",
    "Lead 4 (chiff)",
    "Lead 5 (charang)",
    "Lead 6 (voice)",
    "Lead 7 (fifths)",
    "Lead 8 (bass + lead)",
    # 88-95 Synth Pad
    "Pad 1 (new age)",
    "Pad 2 (warm)",
    "Pad 3 (polysynth)",
    "Pad 4 (choir)",
    "Pad 5 (bowed)",
    "Pad 6 (metallic)",
    "Pad 7 (halo)",
    "Pad 8 (sweep)",
    # 96-103 Synth Effects
    "FX 1 (rain)",
    "FX 2 (soundtrack)",
    "FX 3 (crystal)",
    "FX 4 (atmosphere)",
    "FX 5 (brightness)",
    "FX 6 (goblins)",
    "FX 7 (echoes)",
    "FX 8 (sci-fi)",
    # 104-111 Ethnic
    "Sitar",
    "Banjo",
    "Shamisen",
    "Koto",
    "Kalimba",
    "Bag pipe",
    "Fiddle",
    "Shanai",
    # 112-119 Percussive
    "Tinkle Bell",
    "Agogo",
    "Steel Drums",
    "Woodblock",
    "Taiko Drum",
    "Melodic Tom",
    "Synth Drum",
    "Reverse Cymbal",
    # 120-127 Sound Effects
    "Guitar Fret Noise",
    "Breath Noise",
    "Seashore",
    "Bird Tweet",
    "Telephone Ring",
    "Helicopter",
    "Applause",
    "Gunshot",
)

assert len(GM_PROGRAM_NAMES) == 128 == len(GM_FAMILY_NAMES) * PROGRAMS_PER_FAMILY

# MIDIチャンネル10（0始まりで9）はGMのパーカッションチャンネル。
# ドラムキット切り替え（Bank Select併用）は対象外——このチャンネルを使うトラックは
# 一覧に表示するが、音色変更UIは出さない（miditrack/CLAUDE.md参照）。
PERCUSSION_CHANNEL = 9


def program_name(program: int) -> str:
    """GMプログラム番号(0-127)から音色名を返す。範囲外はValueError。"""
    if not 0 <= program <= 127:
        raise ValueError(f"GMプログラム番号は0-127の範囲で指定してください: {program}")
    return GM_PROGRAM_NAMES[program]


def family_of(program: int) -> str:
    """GMプログラム番号(0-127)から所属ファミリー名を返す。範囲外はValueError。"""
    if not 0 <= program <= 127:
        raise ValueError(f"GMプログラム番号は0-127の範囲で指定してください: {program}")
    return GM_FAMILY_NAMES[program // PROGRAMS_PER_FAMILY]


def instrument_catalog() -> list[dict]:
    """/api/instruments が返す構造そのもの: 16ファミリー×8音色。"""
    catalog = []
    for family_index, family_name in enumerate(GM_FAMILY_NAMES):
        start = family_index * PROGRAMS_PER_FAMILY
        programs = [
            {"program": program, "name": GM_PROGRAM_NAMES[program]}
            for program in range(start, start + PROGRAMS_PER_FAMILY)
        ]
        catalog.append({"name": family_name, "programs": programs})
    return catalog

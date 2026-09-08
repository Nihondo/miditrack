"""Webアプリが外部実行系へ依存する入口を正規化する。"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from . import convert, libvgm, mix, nsf_chip, render, rubberband
from .convert import SourceFormat

Renderer = Callable[[Path, Path, Path | None], None]
ListSongs = Callable[[SourceFormat, Path], tuple[dict[str, Any], list[dict[str, Any]]]]
Converter = Callable[[SourceFormat, Path, Path, dict[str, Any]], tuple[Path | None, Path | None]]
StemTransformer = Callable[[Path, Path, float, int], None]
Mixer = Callable[[list[tuple[Path, float]], Path], None]
GainApplier = Callable[[Path, Path, float], None]
LibvgmRenderer = Callable[[Path, Path, int, list[libvgm.LibvgmTarget]], None]
NsfChipRenderer = Callable[[Path, Path, int, list[nsf_chip.NsfChipTarget], int], None]


@dataclass(frozen=True)
class RuntimeDependencies:
    """本番実装またはテスト注入された外部処理への内部境界。"""

    renderer: Renderer | None = None
    list_songs: ListSongs | None = None
    converter: Converter | None = None
    stem_transformer: StemTransformer | None = None
    mixer: Mixer | None = None
    gain_applier: GainApplier | None = None
    libvgm_renderer: LibvgmRenderer | None = None
    nsf_chip_renderer: NsfChipRenderer | None = None

    def render_wav(
        self, midi_path: Path, wav_path: Path, soundfont: Path | None, sample_rate: int
    ) -> None:
        """テスト用の旧3引数レンダラを保ちながら本番レンダラを呼ぶ。"""
        if self.renderer is not None:
            self.renderer(midi_path, wav_path, soundfont)
            return
        render.render_wav(midi_path, wav_path, soundfont, sample_rate=sample_rate)

    def mix_wav(
        self, inputs: list[tuple[Path, float]], output_path: Path, sample_rate: int
    ) -> None:
        """テスト用の旧2引数ミキサーを保ちながら本番ミキサーを呼ぶ。"""
        if self.mixer is not None:
            self.mixer(inputs, output_path)
            return
        mix.mix_wav(inputs, output_path, sample_rate=sample_rate)

    def apply_gain(
        self, input_path: Path, output_path: Path, gain: float, sample_rate: int
    ) -> None:
        """テスト注入可能なゲイン適用を実行する。"""
        if self.gain_applier is not None:
            self.gain_applier(input_path, output_path, gain)
            return
        mix.apply_gain(input_path, output_path, gain, sample_rate=sample_rate)

    def get_list_songs(self) -> ListSongs:
        """音源一覧取得関数を返す。"""
        return self.list_songs or convert.list_songs

    def get_converter(self) -> Converter:
        """MIDI変換関数を返す。"""
        return self.converter or convert.convert_to_midi

    def get_stem_transformer(self) -> StemTransformer:
        """実音声ステム変換関数を返す。"""
        return self.stem_transformer or rubberband.transform_stem

    def get_libvgm_renderer(self) -> LibvgmRenderer:
        """VGM選択レンダラを返す。"""
        return self.libvgm_renderer or libvgm.render_selection

    def get_nsf_chip_renderer(self) -> NsfChipRenderer:
        """NSF選択レンダラを返す。"""
        return self.nsf_chip_renderer or nsf_chip.render_selection

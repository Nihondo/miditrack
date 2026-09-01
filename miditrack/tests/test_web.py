"""miditrack.web のテスト。

renderer を注入することで実際の fluidsynth/midi2wav.sh は起動しない。
"""

from __future__ import annotations

import io
import json
import os
import tempfile
import threading
import time
import unittest
import zipfile
from pathlib import Path
from unittest import mock

import mido

from miditrack import libvgm, mix, nsf_chip, preferences
from miditrack.convert import SourceFormat
from miditrack.errors import ConvertError, RenderError
from miditrack.web import (
    WebSession,
    _track_filename_label,
    create_app,
    resolve_startup_soundfont_override,
)


def build_zip_bytes(members: dict[str, bytes]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as zf:
        for name, data in members.items():
            zf.writestr(name, data)
    return buffer.getvalue()

TOKEN = "test-token"
AUTH_HEADERS = {"X-Miditrack-Token": TOKEN}

# POST /api/soundfontはpreferences.save_preferences()を呼ぶため、このモジュール
# 全体で実際のユーザー設定(~/Library/Application Support/miditrack/preferences.json)
# を汚染しないよう、一時ディレクトリへ差し替える。TestWebAppPreferencesが
# 自分のテスト用に一時的に切り替える分もこの上に正しくネストして復元される。
_preferences_tmpdir: tempfile.TemporaryDirectory | None = None
_preferences_env_backup: str | None = None


def setUpModule() -> None:
    global _preferences_tmpdir, _preferences_env_backup
    _preferences_tmpdir = tempfile.TemporaryDirectory()
    _preferences_env_backup = os.environ.get("MIDITRACK_PREFERENCES_PATH")
    os.environ["MIDITRACK_PREFERENCES_PATH"] = str(
        Path(_preferences_tmpdir.name) / "preferences.json"
    )


def tearDownModule() -> None:
    if _preferences_env_backup is None:
        os.environ.pop("MIDITRACK_PREFERENCES_PATH", None)
    else:
        os.environ["MIDITRACK_PREFERENCES_PATH"] = _preferences_env_backup
    if _preferences_tmpdir is not None:
        _preferences_tmpdir.cleanup()


def build_fixture_bytes() -> bytes:
    mf = mido.MidiFile(ticks_per_beat=480)

    t0 = mido.MidiTrack()
    t0.append(mido.MetaMessage("track_name", name="Lead", time=0))
    t0.append(mido.Message("program_change", program=80, channel=0, time=0))
    t0.append(mido.Message("note_on", note=60, velocity=100, channel=0, time=0))
    t0.append(mido.Message("note_off", note=60, velocity=0, channel=0, time=480))
    mf.tracks.append(t0)

    t1 = mido.MidiTrack()
    t1.append(mido.MetaMessage("track_name", name="Noise", time=0))
    t1.append(mido.Message("note_on", note=42, velocity=100, channel=9, time=0))
    t1.append(mido.Message("note_off", note=42, velocity=0, channel=9, time=240))
    mf.tracks.append(t1)

    buffer = io.BytesIO()
    mf.save(file=buffer)
    return buffer.getvalue()


def build_cc7_fixture_bytes(cc7_value: int = 64) -> bytes:
    """変換元CC7音量を持つ単一トラックのMIDIフィクスチャ。

    miditrack.midi.TestSourceVolumePercentの発想を再利用しつつ、Web層
    (アップロード/PATCH/レンダリング)のテスト用に最小構成にしたもの。
    """
    mf = mido.MidiFile(ticks_per_beat=480)
    t0 = mido.MidiTrack()
    t0.append(mido.MetaMessage("track_name", name="Quiet", time=0))
    t0.append(mido.Message("control_change", control=7, value=cc7_value, channel=0, time=0))
    t0.append(mido.Message("program_change", program=80, channel=0, time=0))
    t0.append(mido.Message("note_on", note=60, velocity=100, channel=0, time=0))
    t0.append(mido.Message("note_off", note=60, velocity=0, channel=0, time=480))
    mf.tracks.append(t0)
    buffer = io.BytesIO()
    mf.save(file=buffer)
    return buffer.getvalue()


def build_two_track_cc7_fixture_bytes(cc7_value: int = 64) -> bytes:
    """track0がCC7=cc7_value（減衰）、track1はCC7無し（既定100%）の2トラック。

    「原曲の音源」選択の一方だけが実機レンダリング対象になるケース
    （mix_wav()が実際に呼ばれる、dryレンダリング1本+実機ステム1本の構成）用。
    """
    mf = mido.MidiFile(ticks_per_beat=480)
    t0 = mido.MidiTrack()
    t0.append(mido.MetaMessage("track_name", name="Quiet", time=0))
    t0.append(mido.Message("control_change", control=7, value=cc7_value, channel=0, time=0))
    t0.append(mido.Message("note_on", note=60, velocity=100, channel=0, time=0))
    t0.append(mido.Message("note_off", note=60, velocity=0, channel=0, time=480))
    mf.tracks.append(t0)

    t1 = mido.MidiTrack()
    t1.append(mido.MetaMessage("track_name", name="Plain", time=0))
    t1.append(mido.Message("note_on", note=64, velocity=100, channel=1, time=0))
    t1.append(mido.Message("note_off", note=64, velocity=0, channel=1, time=480))
    mf.tracks.append(t1)

    buffer = io.BytesIO()
    mf.save(file=buffer)
    return buffer.getvalue()


class TestWebApp(unittest.TestCase):
    def setUp(self) -> None:
        self.render_calls: list[tuple[Path, Path, Path | None]] = []
        self.list_songs_calls: list[tuple[SourceFormat, Path]] = []
        self.convert_calls: list[tuple[SourceFormat, Path, Path, dict]] = []
        self.pitch_shift_calls: list[tuple[Path, Path, list[float], list[float]]] = []
        self.fake_songs = [
            {"index": 0, "label": "Song A", "durationSeconds": 30.0, "detail": None},
            {"index": 1, "label": "Song B", "durationSeconds": None, "detail": None},
        ]

        def fake_renderer(mid_path: Path, wav_path: Path, soundfont: Path | None) -> None:
            self.render_calls.append((mid_path, wav_path, soundfont))
            wav_path.write_bytes(b"0" * 200)

        def fake_list_songs(fmt: SourceFormat, source_path: Path):
            self.list_songs_calls.append((fmt, source_path))
            return {"Title": "Fake Source"}, self.fake_songs

        def fake_converter(
            fmt: SourceFormat, source_path: Path, output_path: Path, options: dict
        ) -> tuple[Path | None, Path | None]:
            self.convert_calls.append((fmt, source_path, output_path, options))
            output_path.write_bytes(build_fixture_bytes())
            return None, None

        def fake_pitch_shifter(
            wav_path: Path, work_dir: Path, speeds: list[float], pitches: list[float]
        ) -> list[Path]:
            self.pitch_shift_calls.append((wav_path, work_dir, speeds, pitches))
            outputs = []
            for s in speeds:
                for p in pitches:
                    out = work_dir / f"variant_x{s}_p{p}.wav"
                    out.write_bytes(b"0" * 100)
                    outputs.append(out)
            return outputs

        self.fake_list_songs = fake_list_songs
        self.fake_converter = fake_converter
        self.fake_pitch_shifter = fake_pitch_shifter

        self.app = create_app(
            token=TOKEN,
            session=WebSession(),
            renderer=fake_renderer,
            list_songs=fake_list_songs,
            converter=fake_converter,
            pitch_shifter=fake_pitch_shifter,
        )
        self.client = self.app.test_client()
        self.addCleanup(self._clear_session)

    def _clear_session(self) -> None:
        session = self.app.config["MIDITRACK_SESSION"]
        session.clear()

    def _upload(self):
        data = {"midi": (io.BytesIO(build_fixture_bytes()), "fixture.mid")}
        return self.client.post(
            "/api/session", headers=AUTH_HEADERS, data=data, content_type="multipart/form-data"
        )

    # --- 認証 ---

    def test_missing_token_is_rejected(self) -> None:
        response = self.client.get("/api/session")
        self.assertEqual(response.status_code, 403)

    def test_valid_token_is_accepted(self) -> None:
        response = self.client.get("/api/session", headers=AUTH_HEADERS)
        self.assertEqual(response.status_code, 200)

    def test_bad_host_is_rejected(self) -> None:
        response = self.client.get(
            "/api/session", headers={**AUTH_HEADERS, "Host": "evil.example"}
        )
        self.assertEqual(response.status_code, 403)

    def test_bad_origin_is_rejected(self) -> None:
        response = self.client.get(
            "/api/session", headers={**AUTH_HEADERS, "Origin": "https://evil.example"}
        )
        self.assertEqual(response.status_code, 403)

    def test_security_headers_present(self) -> None:
        response = self.client.get("/api/session", headers=AUTH_HEADERS)
        csp = response.headers.get("Content-Security-Policy", "")
        self.assertIn("media-src 'self'", csp)
        self.assertIn("frame-ancestors 'none'", csp)
        self.assertEqual(response.headers.get("X-Content-Type-Options"), "nosniff")
        self.assertEqual(response.headers.get("X-Frame-Options"), "DENY")
        self.assertEqual(response.headers.get("Referrer-Policy"), "no-referrer")

    def test_render_mode_radios_stay_visually_hidden_while_focused(self) -> None:
        html = self.client.get("/").get_data(as_text=True)
        css = self.client.get("/assets/app.css").get_data(as_text=True)

        self.assertIn('class="render-mode-input" type="radio"', html)
        self.assertNotIn('class="visually-hidden" type="radio" name="render-mode"', html)
        self.assertIn('label for="render-mode-fast"', html)
        self.assertIn('label for="render-mode-quality"', html)
        hidden_rule = css.split(".render-mode-input {", 1)[1].split("}", 1)[0]
        self.assertIn("position: absolute !important", hidden_rule)
        self.assertIn("clip-path: inset(50%) !important", hidden_rule)

    def test_render_mode_toggle_is_compact_and_spinner_reserves_playback_space(self) -> None:
        html = self.client.get("/").get_data(as_text=True)
        css = self.client.get("/assets/app.css").get_data(as_text=True)
        soundfont_row = html.split('<div class="soundfont-row">', 1)[1].split(
            '<p class="field-help" id="soundfont-help">', 1
        )[0]

        self.assertLess(
            soundfont_row.index("soundfont-select"),
            soundfont_row.index("render-mode-field"),
        )
        self.assertIn('<label for="render-mode-fast">高速</label>', soundfont_row)
        self.assertIn('<label for="render-mode-quality">品質</label>', soundfont_row)
        self.assertNotIn("22.05kHzで素早く確認", html)
        self.assertNotIn("最終WAVと同じ44.1kHz", html)
        row_rule = css.split(".soundfont-row {", 1)[1].split("}", 1)[0]
        field_rule = css.split(".render-mode-field {", 1)[1].split("}", 1)[0]
        options_rule = css.split(".render-mode-options {", 1)[1].split("}", 1)[0]
        spinner_slot_rule = css.split(".render-spinner-slot {", 1)[1].split("}", 1)[0]
        audition_toolbar = html.split('<div class="toolbar audition-toolbar">', 1)[1].split(
            '<!-- 試聴用<audio>を2枚', 1
        )[0]
        self.assertIn("grid-template-columns: minmax(0, 1fr) auto", row_rule)
        self.assertIn("align-self: stretch", field_rule)
        self.assertIn("height: 100%", options_rule)
        self.assertNotIn('id="render-spinner"', soundfont_row)
        self.assertLess(
            audition_toolbar.index('class="playback-controls"'),
            audition_toolbar.index('class="render-spinner-slot"'),
        )
        self.assertLess(
            audition_toolbar.index('class="render-spinner-slot"'),
            audition_toolbar.index('id="playback-time"'),
        )
        self.assertIn('id="render-spinner" hidden', audition_toolbar)
        self.assertIn('flex: 0 0 16px', spinner_slot_rule)
        self.assertIn('place-items: center', spinner_slot_rule)
        self.assertNotIn("render-button", html)
        self.assertIn("@keyframes render-spinner-rotate", css)
        self.assertNotIn("prefers-reduced-motion: reduce", css)

    def test_track_source_uses_same_segmented_radio_design_as_render_mode(self) -> None:
        javascript = self.client.get("/assets/app.js").get_data(as_text=True)
        css = self.client.get("/assets/app.css").get_data(as_text=True)
        source_control = javascript.split("function createTrackSourceOption", 1)[1].split(
            "function applyProgramToAllTracks", 1
        )[0]

        self.assertIn('fieldset.className = "render-mode-field track-source-field"', source_control)
        self.assertIn('options.className = "render-mode-options track-source-options"', source_control)
        self.assertIn('input.className = "render-mode-input track-source-input"', source_control)
        self.assertIn('input.type = "radio"', source_control)
        self.assertIn('label.textContent = source === "game" ? "原曲" : "SF"', source_control)
        self.assertIn("legend.textContent = `${track.name}の音源`", source_control)
        self.assertNotIn('document.createElement("select")', source_control)
        self.assertIn(".track-source-field {", css)
        self.assertIn(".track-source-options {", css)
        self.assertNotIn(".source-select {", css)

    def test_pianoroll_playhead_does_not_recopy_large_canvas_each_frame(self) -> None:
        """高倍率の再生ループが静的Canvas全体を再転送しないことを確認する。"""
        html = self.client.get("/").get_data(as_text=True)
        css = self.client.get("/assets/app.css").get_data(as_text=True)
        javascript = self.client.get("/assets/app.js").get_data(as_text=True)

        self.assertIn('id="pianoroll-timeline"', html)
        self.assertIn('id="pianoroll-playhead"', html)
        self.assertIn("function updatePianorollPlayhead()", javascript)
        self.assertNotIn("pianorollBase", javascript)
        self.assertIn("if (x > width || x + noteWidth < 0) continue;", javascript)
        self.assertIn("function schedulePianorollViewportRedraw()", javascript)

        progress_block = javascript.split("function updatePlaybackProgress() {", 1)[1].split(
            "\n}", 1
        )[0]
        self.assertIn("updatePianorollPlayhead();", progress_block)
        self.assertNotIn("redrawPianorollStatic", progress_block)
        self.assertNotIn("drawImage", progress_block)

        zoom_block = javascript.split("function setPianorollZoom(", 1)[1].split(
            "\n}", 1
        )[0]
        self.assertIn('const timeline = $("#pianoroll-timeline")', zoom_block)
        self.assertIn("timeline.style.inlineSize", zoom_block)
        self.assertIn('id="pianoroll-viewport"', html)
        viewport_rule = css.split(".pianoroll-viewport {", 1)[1].split("}", 1)[0]
        self.assertIn("position: sticky", viewport_rule)
        self.assertIn('viewport.style.inlineSize = `${width}px`', javascript)
        playhead_rule = css.split(".pianoroll-playhead {", 1)[1].split("}", 1)[0]
        self.assertIn("pointer-events: none", playhead_rule)
        self.assertIn("transform: translate3d", playhead_rule)

    def test_pianoroll_preserves_vertical_pitch_separation(self) -> None:
        """低い全画面領域でも隣接する音高のノート矩形を重ねない。"""
        css = self.client.get("/assets/app.css").get_data(as_text=True)
        javascript = self.client.get("/assets/app.js").get_data(as_text=True)

        fullscreen_roll_rule = css.split("body.is-fullscreen .pianoroll-card {", 1)[1].split("}", 1)[0]
        self.assertIn("min-height: 260px", fullscreen_roll_rule)
        draw_track_block = javascript.split("function drawPianorollTrack", 1)[1].split(
            "function redrawPianorollStatic", 1
        )[0]
        self.assertIn("const pitchBounds = pianorollPitchBounds(note, layout)", draw_track_block)
        self.assertIn("pitchBounds.height * 0.8", draw_track_block)

    def test_file_open_dialog_is_limited_to_fullscreen(self) -> None:
        """通常表示はアップロードカード、全画面だけは同カードを開くダイアログへ移す。"""
        html = self.client.get("/").get_data(as_text=True)
        css = self.client.get("/assets/app.css").get_data(as_text=True)
        javascript = self.client.get("/assets/app.js").get_data(as_text=True)

        header_actions = html.split('class="header-actions"', 1)[1].split("</div>", 1)[0]
        self.assertLess(
            header_actions.index('id="open-dialog-button"'),
            header_actions.index('id="fullscreen-toggle"'),
        )
        self.assertIn('id="open-dialog" closedby="any"', html)
        self.assertIn('aria-labelledby="upload-card-title"', html)
        self.assertIn('id="open-dialog-close"', html)
        self.assertIn('id="midi-input"', html)
        self.assertIn('id="open-project-button"', html)
        self.assertIn('id="upload-card" open', html)
        self.assertLess(html.index('id="upload-card"'), html.index('id="tracks-card"'))
        self.assertIn("音源またはMIDIを選択", html)
        self.assertIn('id="tracks-card-heading"', html)
        self.assertIn("トラックごとの音源・楽器・音量", html)
        self.assertIn("#open-dialog-button,\n#open-dialog-close { display: none; }", css)
        self.assertIn("body.is-fullscreen #open-dialog-button { display: inline-flex; }", css)
        self.assertIn("body.is-fullscreen #open-dialog > #upload-card {", css)
        self.assertIn("body.is-fullscreen #tracks-card-heading { display: none; }", css)
        self.assertIn("function setupOpenDialog()", javascript)
        self.assertIn("function moveUploadCardToDialog()", javascript)
        self.assertIn("function moveUploadCardToShell()", javascript)
        self.assertIn('dialog.showModal()', javascript)
        self.assertIn('if (!("closedBy" in HTMLDialogElement.prototype))', javascript)
        self.assertIn('if (dialog.open) dialog.close();', javascript)
        self.assertIn(
            'body.is-fullscreen .app-shell > #tracks-card { grid-column: 1; grid-row: 1 / 6; }',
            css,
        )
        self.assertIn("border-top: 1px solid var(--neutral-30)", css)

    def test_pianoroll_draws_pitchwheel_paths(self) -> None:
        """ピッチベンドはノート本体と分離したDAW風オートメーションとして描画する。"""
        javascript = self.client.get("/assets/app.js").get_data(as_text=True)

        self.assertIn("function drawPitchAutomationGrid", javascript)
        self.assertIn("function drawPitchAutomation", javascript)
        self.assertIn("track.pitchPaths || []", javascript)
        self.assertIn('context.fillText("PITCH", 7, center)', javascript)
        self.assertIn("drawPianorollNote(", javascript)
        self.assertIn("pianorollPitchBounds(note, layout)", javascript)

    def test_song_picker_is_shown_only_when_multiple_candidates_exist(self) -> None:
        """単一候補は隠しつつ、その曲番号を変換時に送ることを確認する。"""
        javascript = self.client.get("/assets/app.js").get_data(as_text=True)

        self.assertIn("songGroup.hidden = source.songs.length <= 1;", javascript)
        self.assertIn('$("#convert-song-select").options.length > 0', javascript)
        self.assertIn("options.songIndex = Number($(\"#convert-song-select\").value);", javascript)

    def test_pointer_selection_controls_release_focus_without_harming_keyboard_use(self) -> None:
        javascript = self.client.get("/assets/app.js").get_data(as_text=True)
        selector_block = javascript.split(
            "const POINTER_FOCUS_CONTROL_SELECTOR = [", 1
        )[1].split("].join", 1)[0]

        for control_type in ("radio", "checkbox", "range", "file"):
            self.assertIn(f'input[type="{control_type}"]', selector_block)
        self.assertIn('"select"', selector_block)
        self.assertNotIn('input[type="text"]', selector_block)
        self.assertNotIn('input[type="number"]', selector_block)
        self.assertIn(
            'document.addEventListener("pointerdown", rememberPointerControl, true)',
            javascript,
        )
        self.assertIn(
            'document.addEventListener("change", blurPointerChangedControl)',
            javascript,
        )
        self.assertIn(
            'document.addEventListener("pointerup", blurPointerReleasedRange)',
            javascript,
        )
        self.assertIn(
            "!control\n    || control !== state.pointerActivatedControl",
            javascript,
        )
        self.assertIn('if (event.detail === 0) return', javascript)

    def test_render_reload_preserves_relative_playback_position(self) -> None:
        """再レンダリング後も音を止めずに乗り換える、A/Bクロスフェード実装の存在を確認する。

        再生中のクロスフェードは実ブラウザでなければ検証できないため、ここでは
        app.js自体の文字列を検査し、（1）設定変更が<audio>のsrc/再生に触れない
        markRenderStale()経由になっていること、（2）crossfadeToRender()が曲長の
        変化（速度変更）を跨いでも進捗率ベースで位置を復元すること、の2点を
        リグレッションガードする。miditrack/CLAUDE.mdの
        「Why render-then-play, not a live softsynth」も参照。
        """
        javascript = self.client.get("/assets/app.js").get_data(as_text=True)

        # 設定変更はresetPlayer()（<audio>のsrcを外すハードリセット）ではなく、
        # 再生を止めないmarkRenderStale()を経由する。
        self.assertIn("function markRenderStale()", javascript)
        self.assertIn("function scheduleAutoRender(delay = PREWARM_DELAY_MS)", javascript)
        self.assertNotIn("resetPlayer({ preservePosition: true })", javascript)

        # crossfadeToRender()は絶対秒ではなく進捗率で位置を換算する
        # （速度変更で曲長が変わっても音楽上の同じ位置を継続するため）。
        self.assertIn("function crossfadeToRender(renderId, canCommit)", javascript)
        self.assertIn("async function runSwap(renderId, canCommit = () => true)", javascript)
        self.assertIn(
            "if (!Number.isFinite(fromDuration) || fromDuration <= 0) return 0;",
            javascript,
        )
        # ロード待ち・play()の起動待ちで進み続けたactiveの位置に合わせて、フェード
        # 開始前（next.volumeがまだ0の間）にもう一度シークし直す。これが無いと
        # 乗り換えの瞬間にピアノロールの再生位置バーが一瞬ずれて見える回帰を防ぐ。
        self.assertIn("seekNextTo(currentRatio())", javascript)
        self.assertEqual(javascript.count("seekNextTo(currentRatio())"), 2)

    def test_speed_change_defers_pianoroll_duration_update_until_audio_catches_up(
        self,
    ) -> None:
        """速度変更時のピアノロール再生位置バーの一瞬のズレ・不要な再描画を防ぐ実装を確認する。

        pianoroll.pyのdurationSecondsは速度（tempoのスケール）だけで決まり、transposeでは
        変わらない。再生中に速度を変えると、旧速度のまま鳴っている音の経過秒数を新しい
        durationSecondsで割ることになり、クロスフェードで音が実際に切り替わるまでの間
        再生位置バーがずれて見える回帰を防ぐ。また、速度のみの変更ではノートの相対位置
        （x座標比率）は数学的に不変なので、static layerの再描画も不要であることを確認する。
        miditrack/CLAUDE.mdの「Two follow-up fixes to the piano-roll playhead」も参照。
        """
        javascript = self.client.get("/assets/app.js").get_data(as_text=True)

        # フェッチと反映のタイミングを分離: 編集直後に裏で取得を始め、実際に音が
        # 追いついた（またはそもそも再生していなかった）時点でだけ反映する。
        self.assertIn("function schedulePianorollReload(", javascript)
        self.assertIn("async function applyPendingPianorollReload()", javascript)
        self.assertIn("state.pendingPianorollFetch = apiFetch(\"/api/pianoroll\")", javascript)

        # 速度のみの変更（transpose不変）ではノートのstatic layerを再描画しない。
        self.assertIn("needsNoteRedraw", javascript)
        self.assertIn(
            "const transposeChanged = !state.session || state.session.transpose !== transpose;",
            javascript,
        )
        self.assertIn("schedulePianorollReload({ needsNoteRedraw: transposeChanged });", javascript)

        # scheduleAutoRender()・renderGeneration()のどちらも、クロスフェードが
        # 実際に完了した後でだけ反映する。
        self.assertGreaterEqual(javascript.count("await applyPendingPianorollReload();"), 2)

    def test_auto_render_loads_paused_audio_and_playback_waits_for_latest_generation(
        self,
    ) -> None:
        """停止中も最新WAVをロードし、再生で旧音源を鳴らさないことを確認する。"""
        javascript = self.client.get("/assets/app.js").get_data(as_text=True)

        self.assertIn("function requestRenderGeneration(generation)", javascript)
        self.assertIn("async function ensureLatestRender()", javascript)
        self.assertIn("async function playPreparedPlayer(player)", javascript)
        self.assertIn("scheduleAutoRender(0);", javascript)
        self.assertIn('apiFetch("/api/render", {', javascript)
        self.assertNotIn('apiFetch("/api/render/prewarm", {', javascript)
        self.assertIn("if (!isCurrentRenderGeneration(generation)) return null;", javascript)
        self.assertIn("await ensureLatestRender();", javascript)
        self.assertIn("await flushPendingTransform()", javascript)
        self.assertIn("setRenderSpinner(true)", javascript)
        self.assertIn("setRenderSpinner(false)", javascript)

    # --- アップロード ---

    def test_upload_returns_track_payload(self) -> None:
        response = self._upload()
        self.assertEqual(response.status_code, 201)
        payload = response.get_json()
        self.assertEqual(payload["filename"], "fixture")
        self.assertEqual(len(payload["tracks"]), 2)
        self.assertTrue(payload["tracks"][0]["editable"])
        self.assertEqual(payload["tracks"][0]["currentProgram"], 80)
        self.assertEqual(payload["tracks"][0]["volumePercent"], 100)
        self.assertTrue(payload["tracks"][0]["volumeEditable"])
        self.assertFalse(payload["tracks"][1]["editable"])
        self.assertEqual(payload["tracks"][1]["reason"], "percussion")
        self.assertTrue(payload["tracks"][1]["volumeEditable"])

    def test_upload_wrong_extension_is_rejected(self) -> None:
        data = {"midi": (io.BytesIO(b"not midi"), "fixture.txt")}
        response = self.client.post(
            "/api/session", headers=AUTH_HEADERS, data=data, content_type="multipart/form-data"
        )
        self.assertEqual(response.status_code, 400)

    def test_upload_garbage_bytes_is_rejected(self) -> None:
        data = {"midi": (io.BytesIO(b"this is not a real midi file"), "fixture.mid")}
        response = self.client.post(
            "/api/session", headers=AUTH_HEADERS, data=data, content_type="multipart/form-data"
        )
        self.assertEqual(response.status_code, 400)

    def test_upload_without_file_is_rejected(self) -> None:
        response = self.client.post(
            "/api/session", headers=AUTH_HEADERS, data={}, content_type="multipart/form-data"
        )
        self.assertEqual(response.status_code, 400)

    # --- 割り当て ---

    def test_patch_assignment_updates_session_and_invalidates_render(self) -> None:
        self._upload()
        response = self.client.patch(
            "/api/session/tracks",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"assignments": {"0": 30}}),
        )
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["tracks"][0]["assignedProgram"], 30)
        self.assertFalse(payload["hasRender"])

    def test_patch_non_editable_track_is_rejected(self) -> None:
        self._upload()
        response = self.client.patch(
            "/api/session/tracks",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"assignments": {"1": 5}}),
        )
        self.assertEqual(response.status_code, 400)

    def test_patch_without_upload_is_rejected(self) -> None:
        response = self.client.patch(
            "/api/session/tracks",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"assignments": {"0": 30}}),
        )
        self.assertEqual(response.status_code, 400)

    def test_patch_volume_accepts_percussion_and_invalidates_render(self) -> None:
        self._upload()
        self.client.post("/api/render", headers=AUTH_HEADERS)
        response = self.client.patch(
            "/api/session/tracks",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"volumes": {"1": 35}}),
        )
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["tracks"][1]["volumePercent"], 35)
        self.assertFalse(payload["hasRender"])

    def test_patch_volume_rejects_invalid_range(self) -> None:
        self._upload()
        response = self.client.patch(
            "/api/session/tracks",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"volumes": {"0": 201}}),
        )
        self.assertEqual(response.status_code, 400)

    def test_render_applies_track_volume_to_edited_midi(self) -> None:
        self._upload()
        self.client.patch(
            "/api/session/tracks",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"volumes": {"0": 50, "1": 0}}),
        )
        response = self.client.post("/api/render", headers=AUTH_HEADERS)
        self.assertEqual(response.status_code, 200)

        rendered_midi = mido.MidiFile(self.render_calls[-1][0])
        lead = next(message for message in rendered_midi.tracks[0] if message.type == "note_on")
        noise = next(message for message in rendered_midi.tracks[1] if message.type == "note_on")
        self.assertEqual(lead.velocity, 50)
        self.assertEqual(noise.velocity, 0)

    # --- 速度・ピッチ（全体変換） ---

    def test_patch_transform_updates_session_and_invalidates_render(self) -> None:
        self._upload()
        self.client.post("/api/render", headers=AUTH_HEADERS)
        response = self.client.patch(
            "/api/session/transform",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"speed": 1.2, "transpose": -2}),
        )
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["speed"], 1.2)
        self.assertEqual(payload["transpose"], -2)
        self.assertFalse(payload["hasRender"])

    def test_patch_transform_accepts_partial_update(self) -> None:
        self._upload()
        self.client.patch(
            "/api/session/transform",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"speed": 1.5}),
        )
        response = self.client.patch(
            "/api/session/transform",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"transpose": 3}),
        )
        payload = response.get_json()
        self.assertEqual(payload["speed"], 1.5)  # 前回のspeedが保持される
        self.assertEqual(payload["transpose"], 3)

    def test_patch_transform_rejects_invalid_speed(self) -> None:
        self._upload()
        response = self.client.patch(
            "/api/session/transform",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"speed": 0.0}),
        )
        self.assertEqual(response.status_code, 400)

    def test_patch_transform_rejects_invalid_transpose(self) -> None:
        self._upload()
        response = self.client.patch(
            "/api/session/transform",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"transpose": 1.5}),
        )
        self.assertEqual(response.status_code, 400)

    def test_patch_transform_requires_at_least_one_field(self) -> None:
        self._upload()
        response = self.client.patch(
            "/api/session/transform",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({}),
        )
        self.assertEqual(response.status_code, 400)

    def test_patch_transform_without_upload_is_rejected(self) -> None:
        response = self.client.patch(
            "/api/session/transform",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"speed": 1.2}),
        )
        self.assertEqual(response.status_code, 400)

    # --- ピアノロール ---

    def test_pianoroll_without_upload_is_rejected(self) -> None:
        response = self.client.get("/api/pianoroll", headers=AUTH_HEADERS)
        self.assertEqual(response.status_code, 400)

    def test_pianoroll_is_available_before_render(self) -> None:
        self._upload()
        response = self.client.get("/api/pianoroll", headers=AUTH_HEADERS)
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["noteCount"], 2)
        self.assertEqual(len(payload["tracks"]), 2)
        self.assertEqual(self.render_calls, [])

    def test_pianoroll_reflects_transform(self) -> None:
        self._upload()
        original = self.client.get("/api/pianoroll", headers=AUTH_HEADERS).get_json()
        self.client.patch(
            "/api/session/transform",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"speed": 2.0, "transpose": 12}),
        )
        transformed = self.client.get("/api/pianoroll", headers=AUTH_HEADERS).get_json()
        self.assertEqual(transformed["durationSeconds"], original["durationSeconds"] / 2)
        self.assertEqual(transformed["tracks"][0]["notes"][2], 72)
        self.assertEqual(transformed["tracks"][1]["notes"][2], 42)

    def test_track_patch_does_not_change_pianoroll(self) -> None:
        self._upload()
        before = self.client.get("/api/pianoroll", headers=AUTH_HEADERS).get_json()
        self.client.patch(
            "/api/session/tracks",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"assignments": {"0": 30}, "volumes": {"0": 50}}),
        )
        after = self.client.get("/api/pianoroll", headers=AUTH_HEADERS).get_json()
        self.assertEqual(after, before)

    def test_pianoroll_query_token_is_rejected(self) -> None:
        self._upload()
        response = self.client.get(f"/api/pianoroll?token={TOKEN}")
        self.assertEqual(response.status_code, 403)

    def test_render_applies_transform_to_edited_midi(self) -> None:
        self._upload()
        self.client.patch(
            "/api/session/transform",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"speed": 2.0, "transpose": 12}),
        )
        response = self.client.post("/api/render", headers=AUTH_HEADERS)
        self.assertEqual(response.status_code, 200)

        rendered_midi = mido.MidiFile(self.render_calls[-1][0])
        note_on = next(m for m in rendered_midi.tracks[0] if m.type == "note_on")
        self.assertEqual(note_on.note, 72)  # 60+12
        tempos = [
            m.tempo for track in rendered_midi.tracks for m in track if m.type == "set_tempo"
        ]
        self.assertEqual(tempos, [250000])  # build_fixture_bytes()にtempoが無いため挿入される

    def test_uploading_new_midi_resets_transform(self) -> None:
        self._upload()
        self.client.patch(
            "/api/session/transform",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"speed": 1.5, "transpose": 5}),
        )
        response = self._upload()
        payload = response.get_json()
        self.assertEqual(payload["speed"], 1.0)
        self.assertEqual(payload["transpose"], 0)

    def test_default_transform_never_invokes_pitch_shifter(self) -> None:
        # このクラスにはchip_stem_pathが存在しないため、速度・移調を既定値のまま
        # renderしてもpitch_shifter（ステム同期）が呼ばれることはない。
        self._upload()
        self.client.post("/api/render", headers=AUTH_HEADERS)
        self.assertEqual(self.pitch_shift_calls, [])

    # --- ダウンロードファイル名 ---

    def test_patch_filename_updates_download_stem(self) -> None:
        self._upload()
        response = self.client.patch(
            "/api/session/filename",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"name": "my song"}),
        )
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["downloadStem"], "my song")
        # filename（アップロード時の名前）自体は変わらない。
        self.assertEqual(payload["filename"], "fixture")

    def test_patch_filename_sanitizes_unsafe_characters(self) -> None:
        self._upload()
        response = self.client.patch(
            "/api/session/filename",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"name": "a/../b:c*d"}),
        )
        payload = response.get_json()
        self.assertNotIn("/", payload["downloadStem"])
        self.assertNotIn(":", payload["downloadStem"])
        self.assertNotIn("*", payload["downloadStem"])

    def test_patch_filename_blank_clears_override(self) -> None:
        self._upload()
        self.client.patch(
            "/api/session/filename",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"name": "custom"}),
        )
        response = self.client.patch(
            "/api/session/filename",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"name": "   "}),
        )
        payload = response.get_json()
        self.assertEqual(payload["downloadStem"], "")

    def test_patch_filename_requires_name_field(self) -> None:
        self._upload()
        response = self.client.patch(
            "/api/session/filename",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({}),
        )
        self.assertEqual(response.status_code, 400)

    def test_patch_filename_without_upload_is_rejected(self) -> None:
        response = self.client.patch(
            "/api/session/filename",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"name": "custom"}),
        )
        self.assertEqual(response.status_code, 400)

    def test_uploading_new_midi_resets_download_stem(self) -> None:
        self._upload()
        self.client.patch(
            "/api/session/filename",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"name": "custom"}),
        )
        response = self._upload()
        payload = response.get_json()
        self.assertEqual(payload["downloadStem"], "")

    def test_download_midi_uses_custom_filename(self) -> None:
        self._upload()
        self.client.patch(
            "/api/session/filename",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"name": "my song"}),
        )
        response = self.client.get("/api/download", headers=AUTH_HEADERS)
        self.assertIn("my song_miditrack.mid", response.headers.get("Content-Disposition", ""))

    def test_download_wav_uses_custom_filename(self) -> None:
        self._upload()
        self.client.patch(
            "/api/session/filename",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"name": "my song"}),
        )
        response = self.client.get("/api/download/wav", headers=AUTH_HEADERS)
        self.assertIn("my song_miditrack.wav", response.headers.get("Content-Disposition", ""))

    def test_variations_zip_and_members_use_custom_filename(self) -> None:
        self._upload()
        self.client.patch(
            "/api/session/filename",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"name": "my song"}),
        )
        self.client.post("/api/variations", headers=AUTH_HEADERS)
        response = self.client.get("/api/download/variations", headers=AUTH_HEADERS)
        self.assertIn("my song_variations.zip", response.headers.get("Content-Disposition", ""))
        archive = zipfile.ZipFile(io.BytesIO(response.data))
        self.assertTrue(all(name.startswith("my song_") for name in archive.namelist()))

    def test_changing_filename_after_generation_invalidates_variations_zip(self) -> None:
        self._upload()
        self.client.post("/api/variations", headers=AUTH_HEADERS)
        self.client.patch(
            "/api/session/filename",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"name": "renamed"}),
        )
        response = self.client.get("/api/download/variations", headers=AUTH_HEADERS)
        self.assertEqual(response.status_code, 400)

    def test_setting_same_filename_does_not_invalidate_variations_zip(self) -> None:
        self._upload()
        self.client.patch(
            "/api/session/filename",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"name": "custom"}),
        )
        self.client.post("/api/variations", headers=AUTH_HEADERS)
        response = self.client.patch(
            "/api/session/filename",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"name": "custom"}),
        )
        self.assertEqual(response.status_code, 200)
        response = self.client.get("/api/download/variations", headers=AUTH_HEADERS)
        self.assertEqual(response.status_code, 200)

    # --- トラックごとに出力 ---

    def test_track_export_produces_one_wav_per_track(self) -> None:
        self._upload()
        response = self.client.post("/api/tracks/export", headers=AUTH_HEADERS)
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(
            {(item["track"], item["kind"]) for item in payload["items"]},
            {("Lead", "midi"), ("Noise", "midi")},
        )
        self.assertEqual(payload["downloadUrl"], "/api/download/tracks")
        download = self.client.get("/api/download/tracks", headers=AUTH_HEADERS)
        self.assertEqual(download.status_code, 200)
        archive = zipfile.ZipFile(io.BytesIO(download.data))
        self.assertEqual(set(archive.namelist()), {"fixture_Lead_midi.wav", "fixture_Noise_midi.wav"})

    def test_track_export_excludes_muted_track(self) -> None:
        self._upload()
        self.client.patch(
            "/api/session/tracks",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"volumes": {"1": 0}}),
        )
        response = self.client.post("/api/tracks/export", headers=AUTH_HEADERS)
        payload = response.get_json()
        self.assertEqual([item["track"] for item in payload["items"]], ["Lead"])

    def test_track_export_excludes_all_muted_tracks_with_error(self) -> None:
        self._upload()
        self.client.patch(
            "/api/session/tracks",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"volumes": {"0": 0, "1": 0}}),
        )
        response = self.client.post("/api/tracks/export", headers=AUTH_HEADERS)
        self.assertEqual(response.status_code, 400)

    def test_track_export_without_upload_is_rejected(self) -> None:
        response = self.client.post("/api/tracks/export", headers=AUTH_HEADERS)
        self.assertEqual(response.status_code, 400)

    def test_track_export_rejects_non_bool_group_chip_tracks(self) -> None:
        self._upload()
        response = self.client.post(
            "/api/tracks/export",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"groupChipTracks": "yes"}),
        )
        self.assertEqual(response.status_code, 400)

    def test_download_tracks_requires_prior_generation(self) -> None:
        self._upload()
        response = self.client.get("/api/download/tracks", headers=AUTH_HEADERS)
        self.assertEqual(response.status_code, 400)

    def test_download_tracks_invalidated_by_track_change(self) -> None:
        self._upload()
        self.client.post("/api/tracks/export", headers=AUTH_HEADERS)
        self.client.patch(
            "/api/session/tracks",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"assignments": {"0": 30}}),
        )
        response = self.client.get("/api/download/tracks", headers=AUTH_HEADERS)
        self.assertEqual(response.status_code, 400)

    def test_track_export_zip_and_members_use_custom_filename(self) -> None:
        self._upload()
        self.client.patch(
            "/api/session/filename",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"name": "my song"}),
        )
        self.client.post("/api/tracks/export", headers=AUTH_HEADERS)
        response = self.client.get("/api/download/tracks", headers=AUTH_HEADERS)
        self.assertIn("my song_tracks.zip", response.headers.get("Content-Disposition", ""))
        archive = zipfile.ZipFile(io.BytesIO(response.data))
        self.assertTrue(all(name.startswith("my song_") for name in archive.namelist()))

    def test_changing_filename_after_generation_invalidates_track_export_zip(self) -> None:
        self._upload()
        self.client.post("/api/tracks/export", headers=AUTH_HEADERS)
        self.client.patch(
            "/api/session/filename",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"name": "renamed"}),
        )
        response = self.client.get("/api/download/tracks", headers=AUTH_HEADERS)
        self.assertEqual(response.status_code, 400)

    def test_setting_same_filename_does_not_invalidate_track_export_zip(self) -> None:
        self._upload()
        self.client.patch(
            "/api/session/filename",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"name": "custom"}),
        )
        self.client.post("/api/tracks/export", headers=AUTH_HEADERS)
        response = self.client.patch(
            "/api/session/filename",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"name": "custom"}),
        )
        self.assertEqual(response.status_code, 200)
        response = self.client.get("/api/download/tracks", headers=AUTH_HEADERS)
        self.assertEqual(response.status_code, 200)

    def test_track_export_work_dir_is_cleaned_up(self) -> None:
        self._upload()
        self.client.post("/api/tracks/export", headers=AUTH_HEADERS)
        session = self.app.config["MIDITRACK_SESSION"]
        self.assertFalse((session.root / "track_export_work").exists())
        self.assertTrue((session.root / "track_export.zip").exists())

    def test_track_export_does_not_change_session_speed_and_transpose(self) -> None:
        self._upload()
        self.client.patch(
            "/api/session/transform",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"speed": 1.2, "transpose": -2}),
        )
        self.client.post("/api/tracks/export", headers=AUTH_HEADERS)
        session_payload = self.client.get("/api/session", headers=AUTH_HEADERS).get_json()
        self.assertEqual(session_payload["speed"], 1.2)
        self.assertEqual(session_payload["transpose"], -2)

    def test_track_export_name_preserves_dot_in_track_name(self) -> None:
        """トラック名の`.`がsanitize_stem()のようにPath(...).stemで切り詰められないことを確認する。"""
        mf = mido.MidiFile(ticks_per_beat=480)
        t0 = mido.MidiTrack()
        t0.append(mido.MetaMessage("track_name", name="St.Trumpet", time=0))
        t0.append(mido.Message("note_on", note=60, velocity=100, channel=0, time=0))
        t0.append(mido.Message("note_off", note=60, velocity=0, channel=0, time=480))
        mf.tracks.append(t0)
        buffer = io.BytesIO()
        mf.save(file=buffer)
        data = {"midi": (io.BytesIO(buffer.getvalue()), "fixture.mid")}
        self.client.post(
            "/api/session", headers=AUTH_HEADERS, data=data, content_type="multipart/form-data"
        )
        response = self.client.post("/api/tracks/export", headers=AUTH_HEADERS)
        payload = response.get_json()
        self.assertEqual(payload["items"][0]["file"], "fixture_St.Trumpet_midi.wav")

    # --- レンダリング/試聴/ダウンロード ---

    def test_render_invokes_injected_renderer(self) -> None:
        self._upload()
        self.client.patch(
            "/api/session/tracks",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"assignments": {"0": 30}}),
        )
        response = self.client.post("/api/render", headers=AUTH_HEADERS)
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["renderId"], 1)
        self.assertIn("v=1", payload["audioUrl"])
        self.assertEqual(len(self.render_calls), 1)

    def test_audio_requires_render_first(self) -> None:
        self._upload()
        response = self.client.get("/api/audio", headers=AUTH_HEADERS)
        self.assertEqual(response.status_code, 400)

    def test_audio_accepts_query_token_no_header(self) -> None:
        self._upload()
        self.client.post("/api/render", headers=AUTH_HEADERS)
        response = self.client.get(f"/api/audio?v=1&token={TOKEN}")
        self.assertEqual(response.status_code, 200)

    def test_audio_rejects_no_token_at_all(self) -> None:
        self._upload()
        self.client.post("/api/render", headers=AUTH_HEADERS)
        response = self.client.get("/api/audio?v=1")
        self.assertEqual(response.status_code, 403)

    def test_audio_supports_range_for_seeking(self) -> None:
        self._upload()
        self.client.post("/api/render", headers=AUTH_HEADERS)
        response = self.client.get(
            f"/api/audio?v=1&token={TOKEN}", headers={"Range": "bytes=0-9"}
        )
        self.assertEqual(response.status_code, 206)
        self.assertIn("bytes 0-9/", response.headers.get("Content-Range", ""))

    def test_download_requires_header_query_alone_fails(self) -> None:
        self._upload()
        response = self.client.get(f"/api/download?token={TOKEN}")
        self.assertEqual(response.status_code, 403)

    def test_download_works_with_header(self) -> None:
        self._upload()
        response = self.client.get("/api/download", headers=AUTH_HEADERS)
        self.assertEqual(response.status_code, 200)
        self.assertIn("attachment", response.headers.get("Content-Disposition", ""))

    def test_download_wav_requires_header_query_alone_fails(self) -> None:
        self._upload()
        response = self.client.get(f"/api/download/wav?token={TOKEN}")
        self.assertEqual(response.status_code, 403)

    def test_download_wav_renders_on_demand(self) -> None:
        self._upload()
        response = self.client.get("/api/download/wav", headers=AUTH_HEADERS)
        self.assertEqual(response.status_code, 200)
        self.assertIn("attachment", response.headers.get("Content-Disposition", ""))
        self.assertIn(".wav", response.headers.get("Content-Disposition", ""))
        self.assertEqual(len(self.render_calls), 1)

    def test_download_wav_renders_quality_after_fast_preview(self) -> None:
        self._upload()
        self.client.post("/api/render", headers=AUTH_HEADERS)
        self.assertEqual(len(self.render_calls), 1)
        response = self.client.get("/api/download/wav", headers=AUTH_HEADERS)
        self.assertEqual(response.status_code, 200)
        # 既定の高速試聴(22.05kHz)は最終WAVとして流用せず、品質レンダーを行う。
        self.assertEqual(len(self.render_calls), 2)

    def test_download_wav_reuses_quality_preview(self) -> None:
        self._upload()
        response = self.client.post(
            "/api/render",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"renderMode": "quality"}),
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(self.render_calls), 1)
        response = self.client.get("/api/download/wav", headers=AUTH_HEADERS)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(self.render_calls), 1)

    def test_render_modes_are_cached_independently(self) -> None:
        self._upload()
        fast = self.client.post("/api/render", headers=AUTH_HEADERS).get_json()
        quality = self.client.post(
            "/api/render",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"renderMode": "quality"}),
        ).get_json()
        fast_again = self.client.post(
            "/api/render",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"renderMode": "fast"}),
        ).get_json()

        self.assertEqual(fast["sampleRate"], 22050)
        self.assertEqual(quality["sampleRate"], 44100)
        self.assertFalse(fast["cacheHit"])
        self.assertFalse(quality["cacheHit"])
        self.assertTrue(fast_again["cacheHit"])
        self.assertEqual(len(self.render_calls), 2)

    def test_repeated_render_reuses_same_mode_cache(self) -> None:
        self._upload()
        first = self.client.post("/api/render", headers=AUTH_HEADERS).get_json()
        second = self.client.post("/api/render", headers=AUTH_HEADERS).get_json()
        self.assertFalse(first["cacheHit"])
        self.assertTrue(second["cacheHit"])
        self.assertEqual(second["renderId"], first["renderId"])
        self.assertEqual(len(self.render_calls), 1)

    def test_render_cache_evicts_oldest_entry_after_sixteen_states(self) -> None:
        self._upload()
        session = self.app.config["MIDITRACK_SESSION"]
        first_path: Path | None = None
        for program in range(17):
            self.client.patch(
                "/api/session/tracks",
                headers={**AUTH_HEADERS, "Content-Type": "application/json"},
                data=json.dumps({"assignments": {"0": program}}),
            )
            self.client.post("/api/render", headers=AUTH_HEADERS)
            if first_path is None:
                first_path = session.audio_path

        self.assertEqual(len(session.render_cache), 16)
        self.assertIsNotNone(first_path)
        self.assertFalse(first_path.exists())

    def test_new_upload_clears_render_cache_files(self) -> None:
        self._upload()
        self.client.post("/api/render", headers=AUTH_HEADERS)
        session = self.app.config["MIDITRACK_SESSION"]
        cached_path = session.audio_path
        self.assertIsNotNone(cached_path)

        self._upload()

        self.assertEqual(len(session.render_cache), 0)
        self.assertFalse(cached_path.exists())

    def test_failed_render_is_not_cached_and_can_retry(self) -> None:
        attempts = 0

        def flaky_renderer(_mid_path, wav_path, _soundfont):
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                raise RenderError("temporary failure")
            wav_path.write_bytes(b"R" * 200)

        app = create_app(token=TOKEN, session=WebSession(), renderer=flaky_renderer)
        client = app.test_client()
        client.post(
            "/api/session",
            headers=AUTH_HEADERS,
            data={"midi": (io.BytesIO(build_fixture_bytes()), "fixture.mid")},
            content_type="multipart/form-data",
        )

        failed = client.post("/api/render", headers=AUTH_HEADERS)
        recovered = client.post("/api/render", headers=AUTH_HEADERS).get_json()
        cached = client.post("/api/render", headers=AUTH_HEADERS).get_json()

        self.assertEqual(failed.status_code, 502)
        self.assertFalse(recovered["cacheHit"])
        self.assertTrue(cached["cacheHit"])
        self.assertEqual(attempts, 2)
        app.config["MIDITRACK_SESSION"].clear()

    def test_filename_change_does_not_invalidate_preview_cache(self) -> None:
        self._upload()
        self.client.post("/api/render", headers=AUTH_HEADERS)
        self.client.patch(
            "/api/session/filename",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"name": "renamed"}),
        )
        response = self.client.post("/api/render", headers=AUTH_HEADERS).get_json()
        self.assertTrue(response["cacheHit"])
        self.assertEqual(len(self.render_calls), 1)

    def test_prewarm_populates_selected_mode_cache_without_activating_audio(self) -> None:
        self._upload()
        prewarm = self.client.post(
            "/api/render/prewarm",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"renderMode": "quality"}),
        )
        self.assertEqual(prewarm.status_code, 200)
        self.assertFalse(
            self.client.get("/api/session", headers=AUTH_HEADERS).get_json()["hasRender"]
        )
        render_response = self.client.post(
            "/api/render",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"renderMode": "quality"}),
        ).get_json()
        self.assertTrue(render_response["cacheHit"])
        self.assertEqual(len(self.render_calls), 1)

    def test_render_rejects_unknown_mode(self) -> None:
        self._upload()
        response = self.client.post(
            "/api/render",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"renderMode": "studio"}),
        )
        self.assertEqual(response.status_code, 400)

    def test_download_wav_without_upload_is_rejected(self) -> None:
        response = self.client.get("/api/download/wav", headers=AUTH_HEADERS)
        self.assertEqual(response.status_code, 400)

    # --- 速度・ピッチのバリエーション（MIDIレイヤー一括生成） ---

    def test_variations_default_lists_produce_fifteen_combinations(self) -> None:
        self._upload()
        response = self.client.post("/api/variations", headers=AUTH_HEADERS)
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        # 既定値（速度3種 x ピッチ5種）= 15件。単体変換と同じMIDI適用+レンダリングを
        # 組み合わせの数だけ呼ぶので、render_callsも15回になる。
        self.assertEqual(len(payload["items"]), 15)
        self.assertEqual(payload["downloadUrl"], "/api/download/variations")
        self.assertEqual(len(self.render_calls), 15)
        # バッチ経路はMIDIレイヤーで完結し、rubberband(pitch_shift.sh)は
        # 一切呼ばれない（このfixtureにはchip_stem_pathが無いため同期も不要）。
        # これが本改修の看板となる回帰ガード: 旧実装のようにWAV後処理へは
        # 一切フォールバックしない。
        self.assertEqual(self.pitch_shift_calls, [])

    def test_variations_default_includes_midi_in_zip(self) -> None:
        self._upload()
        self.client.post("/api/variations", headers=AUTH_HEADERS)
        response = self.client.get("/api/download/variations", headers=AUTH_HEADERS)
        archive = zipfile.ZipFile(io.BytesIO(response.data))
        names = archive.namelist()
        self.assertEqual(len(names), 30)  # 15組み合わせ x (wav+mid)
        self.assertTrue(any(n.endswith(".mid") for n in names))

    def test_variations_exclude_midi_when_unchecked(self) -> None:
        self._upload()
        response = self.client.post(
            "/api/variations",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"speeds": [1.2, 0.8], "transposes": [0], "includeMidi": False}),
        )
        payload = response.get_json()
        self.assertTrue(all(item["mid"] is None for item in payload["items"]))
        download = self.client.get("/api/download/variations", headers=AUTH_HEADERS)
        archive = zipfile.ZipFile(io.BytesIO(download.data))
        names = archive.namelist()
        self.assertEqual(len(names), 2)  # 2組み合わせ x wavのみ
        self.assertTrue(all(n.endswith(".wav") for n in names))

    def test_variations_rejects_non_bool_include_midi(self) -> None:
        self._upload()
        response = self.client.post(
            "/api/variations",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"speeds": [1.0], "transposes": [0], "includeMidi": "yes"}),
        )
        self.assertEqual(response.status_code, 400)

    def test_variations_uses_custom_lists(self) -> None:
        self._upload()
        response = self.client.post(
            "/api/variations",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"speeds": [1.5], "transposes": [-1, 1]}),
        )
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(len(payload["items"]), 2)
        self.assertEqual(len(self.render_calls), 2)

    def test_variations_rejects_too_many_combinations(self) -> None:
        self._upload()
        speeds = [round(1.0 + i * 0.01, 2) for i in range(6)]
        transposes = list(range(8))
        response = self.client.post(
            "/api/variations",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"speeds": speeds, "transposes": transposes}),
        )
        # バリデーション失敗はそもそも400が正しい（旧実装はPitchShiftError経由で502だった）。
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.render_calls, [])

    def test_variations_rejects_non_integer_transpose(self) -> None:
        self._upload()
        response = self.client.post(
            "/api/variations",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"transposes": [1.5]}),
        )
        self.assertEqual(response.status_code, 400)

    def test_variations_without_upload_is_rejected(self) -> None:
        response = self.client.post("/api/variations", headers=AUTH_HEADERS)
        self.assertEqual(response.status_code, 400)

    def test_variations_zip_contains_wav_and_mid_for_every_combination(self) -> None:
        self._upload()
        self.client.post(
            "/api/variations",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"speeds": [1.2, 0.8], "transposes": [-1, 0]}),
        )
        response = self.client.get("/api/download/variations", headers=AUTH_HEADERS)
        self.assertEqual(response.status_code, 200)
        self.assertIn("attachment", response.headers.get("Content-Disposition", ""))
        self.assertIn(".zip", response.headers.get("Content-Disposition", ""))
        archive = zipfile.ZipFile(io.BytesIO(response.data))
        names = archive.namelist()
        self.assertEqual(len(names), 8)  # 2速度 x 2移調 x (wav+mid)
        for name in names:
            self.assertTrue(name.startswith("fixture_"))
        wav_stems = {n[: -len(".wav")] for n in names if n.endswith(".wav")}
        mid_stems = {n[: -len(".mid")] for n in names if n.endswith(".mid")}
        self.assertEqual(len(wav_stems), 4)
        self.assertEqual(wav_stems, mid_stems)

    def test_variation_filenames_encode_speed_and_transpose(self) -> None:
        self._upload()
        self.client.post(
            "/api/variations",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"speeds": [1.2, 0.8], "transposes": [-2, 0, 2]}),
        )
        response = self.client.get("/api/download/variations", headers=AUTH_HEADERS)
        archive = zipfile.ZipFile(io.BytesIO(response.data))
        expected_stems = {
            "fixture_p-2_x1.2",
            "fixture_p+0_x1.2",
            "fixture_p+2_x1.2",
            "fixture_p-2_x0.8",
            "fixture_p+0_x0.8",
            "fixture_p+2_x0.8",
        }
        self.assertEqual(
            set(archive.namelist()),
            {f"{stem}.{suffix}" for stem in expected_stems for suffix in ("wav", "mid")},
        )

    def test_variation_midi_carries_scaled_tempo_and_shifted_notes(self) -> None:
        self._upload()
        self.client.post(
            "/api/variations",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"speeds": [2.0], "transposes": [12]}),
        )
        response = self.client.get("/api/download/variations", headers=AUTH_HEADERS)
        archive = zipfile.ZipFile(io.BytesIO(response.data))
        variation_midi = mido.MidiFile(file=io.BytesIO(archive.read("fixture_p+12_x2.0.mid")))
        tempos = [
            m.tempo for track in variation_midi.tracks for m in track if m.type == "set_tempo"
        ]
        self.assertEqual(tempos, [250000])  # 500000 / 2.0
        note_on = next(m for m in variation_midi.tracks[0] if m.type == "note_on")
        self.assertEqual(note_on.note, 72)  # 60 + 12

    def test_variations_apply_track_assignments(self) -> None:
        self._upload()
        self.client.patch(
            "/api/session/tracks",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"assignments": {"0": 30}}),
        )
        self.client.post(
            "/api/variations",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"speeds": [1.0], "transposes": [0]}),
        )
        response = self.client.get("/api/download/variations", headers=AUTH_HEADERS)
        archive = zipfile.ZipFile(io.BytesIO(response.data))
        variation_midi = mido.MidiFile(file=io.BytesIO(archive.read("fixture_p+0_x1.0.mid")))
        program_change = next(m for m in variation_midi.tracks[0] if m.type == "program_change")
        self.assertEqual(program_change.program, 30)

    def test_variations_do_not_change_session_speed_and_transpose(self) -> None:
        self._upload()
        self.client.patch(
            "/api/session/transform",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"speed": 1.5, "transpose": 3}),
        )
        self.client.post(
            "/api/variations",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"speeds": [1.2, 0.8], "transposes": [-2, -1, 0, 1, 2]}),
        )
        session_payload = self.client.get("/api/session", headers=AUTH_HEADERS).get_json()
        self.assertEqual(session_payload["speed"], 1.5)
        self.assertEqual(session_payload["transpose"], 3)
        # /api/downloadのMIDIもセッションの値(1.5/3)を反映したままである
        # （バッチが固定名miditrack_edited.midを上書きしていないことのガード）。
        download = self.client.get("/api/download", headers=AUTH_HEADERS)
        downloaded_midi = mido.MidiFile(file=io.BytesIO(download.data))
        tempos = [
            m.tempo for track in downloaded_midi.tracks for m in track if m.type == "set_tempo"
        ]
        self.assertEqual(tempos, [round(500000 / 1.5)])
        note_on = next(m for m in downloaded_midi.tracks[0] if m.type == "note_on")
        self.assertEqual(note_on.note, 63)  # 60 + 3

    def test_variations_preserve_existing_audition_render(self) -> None:
        self._upload()
        self.client.post("/api/render", headers=AUTH_HEADERS)
        before = self.client.get(f"/api/audio?v=1&token={TOKEN}").data
        self.client.post(
            "/api/variations",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"speeds": [1.2, 0.8], "transposes": [-2, -1, 0, 1, 2]}),
        )
        after = self.client.get(f"/api/audio?v=1&token={TOKEN}").data
        self.assertEqual(before, after)
        session_payload = self.client.get("/api/session", headers=AUTH_HEADERS).get_json()
        self.assertTrue(session_payload["hasRender"])

    def test_download_variations_requires_prior_generation(self) -> None:
        self._upload()
        response = self.client.get("/api/download/variations", headers=AUTH_HEADERS)
        self.assertEqual(response.status_code, 400)

    def test_download_variations_invalidated_by_track_change(self) -> None:
        self._upload()
        self.client.post("/api/variations", headers=AUTH_HEADERS)
        self.client.patch(
            "/api/session/tracks",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"assignments": {"0": 30}}),
        )
        response = self.client.get("/api/download/variations", headers=AUTH_HEADERS)
        self.assertEqual(response.status_code, 400)

    def test_variations_work_dir_is_cleaned_up(self) -> None:
        self._upload()
        self.client.post("/api/variations", headers=AUTH_HEADERS)
        session = self.app.config["MIDITRACK_SESSION"]
        self.assertFalse((session.root / "variations_work").exists())
        self.assertTrue((session.root / "variations.zip").exists())

    def test_variations_leave_no_render_temp_files(self) -> None:
        self._upload()
        self.client.post(
            "/api/variations",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"speeds": [1.2, 0.8], "transposes": [-1, 0, 1]}),
        )
        session = self.app.config["MIDITRACK_SESSION"]
        self.assertEqual(list(session.root.glob("render-*.part*.wav")), [])
        self.assertEqual(list(session.root.glob("render-*.dry.mid")), [])
        self.assertEqual(list(session.root.glob("render-*.game.mid")), [])
        self.assertEqual(list(session.root.glob("render-*.gm.mid")), [])
        self.assertEqual(list(session.root.glob("render-*.stemsync")), [])

    # --- SoundFont選択 ---

    def test_get_soundfonts_lists_discovered_items(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            fake = Path(tmp) / "font.sf2"
            fake.write_bytes(b"0")
            fake_items = [
                {"path": str(fake), "name": "font.sf2", "dir": tmp, "sizeBytes": 1}
            ]
            with mock.patch("miditrack.web.render.list_soundfonts", return_value=fake_items):
                response = self.client.get("/api/soundfonts", headers=AUTH_HEADERS)
            self.assertEqual(response.status_code, 200)
            payload = response.get_json()
            self.assertEqual(payload["items"], fake_items)
            self.assertIsNone(payload["selected"])
            self.assertFalse(payload["isOverride"])

    def test_post_soundfont_selects_a_real_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            fake = Path(tmp) / "font.sf2"
            fake.write_bytes(b"0")
            response = self.client.post(
                "/api/soundfont",
                headers={**AUTH_HEADERS, "Content-Type": "application/json"},
                data=json.dumps({"path": str(fake)}),
            )
            self.assertEqual(response.status_code, 200)
            payload = response.get_json()
            self.assertEqual(payload["selected"], str(fake))
            self.assertTrue(payload["isOverride"])

    def test_post_soundfont_rejects_nonexistent_path(self) -> None:
        response = self.client.post(
            "/api/soundfont",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"path": "/definitely/not/here.sf2"}),
        )
        self.assertEqual(response.status_code, 400)

    def test_post_soundfont_rejects_wrong_extension(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            fake = Path(tmp) / "not-a-font.txt"
            fake.write_bytes(b"0")
            response = self.client.post(
                "/api/soundfont",
                headers={**AUTH_HEADERS, "Content-Type": "application/json"},
                data=json.dumps({"path": str(fake)}),
            )
            self.assertEqual(response.status_code, 400)

    def test_post_soundfont_null_clears_override(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            fake = Path(tmp) / "font.sf2"
            fake.write_bytes(b"0")
            self.client.post(
                "/api/soundfont",
                headers={**AUTH_HEADERS, "Content-Type": "application/json"},
                data=json.dumps({"path": str(fake)}),
            )
        response = self.client.post(
            "/api/soundfont",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"path": None}),
        )
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertIsNone(payload["selected"])
        self.assertFalse(payload["isOverride"])

    def test_render_uses_selected_soundfont_over_cli_default(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            fake = Path(tmp) / "font.sf2"
            fake.write_bytes(b"0")

            self._upload()
            self.client.post(
                "/api/soundfont",
                headers={**AUTH_HEADERS, "Content-Type": "application/json"},
                data=json.dumps({"path": str(fake)}),
            )
            self.client.post("/api/render", headers=AUTH_HEADERS)
            self.assertEqual(self.render_calls[-1][2], fake)

    def test_soundfont_selection_persists_across_upload(self) -> None:
        # SoundFont選択はMIDIアップロードとは独立した設定なので、リセットされない。
        with tempfile.TemporaryDirectory() as tmp:
            fake = Path(tmp) / "font.sf2"
            fake.write_bytes(b"0")
            self.client.post(
                "/api/soundfont",
                headers={**AUTH_HEADERS, "Content-Type": "application/json"},
                data=json.dumps({"path": str(fake)}),
            )
            self._upload()
            self.client.post("/api/render", headers=AUTH_HEADERS)
            self.assertEqual(self.render_calls[-1][2], fake)

    # --- セッション削除 ---

    def test_delete_clears_session(self) -> None:
        self._upload()
        response = self.client.delete("/api/session", headers=AUTH_HEADERS)
        self.assertEqual(response.status_code, 200)
        follow_up = self.client.get("/api/session", headers=AUTH_HEADERS)
        self.assertEqual(follow_up.get_json()["trackCount"], 0)

    # --- GM音色カタログ ---

    def test_instruments_endpoint(self) -> None:
        response = self.client.get("/api/instruments", headers=AUTH_HEADERS)
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(len(payload["families"]), 16)

    # --- 音源アップロード・変換 ---

    def _upload_source(self, filename: str = "chip.nsf"):
        data = {"source": (io.BytesIO(b"fake source bytes"), filename)}
        return self.client.post(
            "/api/source", headers=AUTH_HEADERS, data=data, content_type="multipart/form-data"
        )

    def test_source_upload_unsupported_extension_is_rejected(self) -> None:
        response = self._upload_source("chip.txt")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.list_songs_calls, [])

    def test_source_upload_without_file_is_rejected(self) -> None:
        response = self.client.post(
            "/api/source", headers=AUTH_HEADERS, data={}, content_type="multipart/form-data"
        )
        self.assertEqual(response.status_code, 400)

    def test_source_upload_lists_songs_via_injected_list_songs(self) -> None:
        response = self._upload_source("chip.nsf")
        self.assertEqual(response.status_code, 201)
        payload = response.get_json()
        self.assertEqual(payload["source"]["format"], "nsf")
        self.assertEqual(len(payload["source"]["songs"]), 2)
        self.assertEqual(payload["source"]["metadata"]["Title"], "Fake Source")
        self.assertEqual(len(self.list_songs_calls), 1)
        # トラック一覧はまだMIDIに変換していないので空のまま。
        self.assertEqual(payload["trackCount"], 0)

    def test_source_upload_vgm_skips_song_listing(self) -> None:
        response = self._upload_source("chip.vgm")
        self.assertEqual(response.status_code, 201)
        payload = response.get_json()
        self.assertEqual(payload["source"]["songs"], [])
        self.assertEqual(self.list_songs_calls, [])
        option_names = {field["name"] for field in payload["source"]["options"]}
        self.assertIn("ch3SpecialPercussion", option_names)

    def test_source_upload_nsf_exposes_unified_timing_options(self) -> None:
        # NSF/SPC/VGMいずれも「ループ回数」「秒数」を同じ形で公開し、実際に
        # 指定できない方だけunavailable: Trueが立つ。テンポ(BPM)はどの
        # フォーマットにも存在しない（VGMのみ許していた変換時テンポ指定を
        # 廃止したため）。
        response = self._upload_source("chip.nsf")
        options = {f["name"]: f for f in response.get_json()["source"]["options"]}
        self.assertNotIn("tempo", options)
        self.assertTrue(options["loops"]["unavailable"])
        self.assertNotIn("unavailable", options["durationSeconds"])

    def test_source_upload_spc_exposes_unified_timing_options(self) -> None:
        response = self._upload_source("chip.spc")
        options = {f["name"]: f for f in response.get_json()["source"]["options"]}
        self.assertNotIn("tempo", options)
        self.assertTrue(options["durationSeconds"]["unavailable"])
        self.assertNotIn("unavailable", options["loops"])

    def test_source_convert_produces_track_payload(self) -> None:
        self._upload_source("chip.nsf")
        response = self.client.post(
            "/api/source/convert",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"songIndex": 0}),
        )
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(len(payload["tracks"]), 2)
        self.assertEqual(len(self.convert_calls), 1)
        fmt, _source_path, _output_path, options = self.convert_calls[0]
        self.assertEqual(fmt.key, "nsf")
        self.assertEqual(options["songIndex"], 0)
        # 変換後もsourceセクションは維持され、変換カードの状態が復元できる。
        self.assertIsNotNone(payload["source"])

    def test_project_round_trip_preserves_converted_source_options(self) -> None:
        self._upload_source("chip.nsf")
        self.client.post(
            "/api/source/convert",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"songIndex": 1, "durationSeconds": 20, "forcePal": True}),
        )
        exported = self.client.post(
            "/api/project/export",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"renderMode": "fast"}),
        )
        self.assertEqual(exported.status_code, 200)
        with zipfile.ZipFile(io.BytesIO(exported.data)) as archive:
            self.assertIn("source/uploads/chip.nsf", archive.namelist())

        imported = self.client.post(
            "/api/project/import",
            headers=AUTH_HEADERS,
            data={"project": (io.BytesIO(exported.data), "chip.miditrack")},
            content_type="multipart/form-data",
        )
        self.assertEqual(imported.status_code, 200)
        source = imported.get_json()["session"]["source"]
        self.assertEqual(source["format"], "nsf")
        self.assertEqual(source["convertedOptions"]["songIndex"], 1)
        self.assertEqual(source["convertedOptions"]["durationSeconds"], 20)
        self.assertTrue(source["convertedOptions"]["forcePal"])

    def test_source_reconversion_uses_a_new_audio_cache_key(self) -> None:
        self._upload_source("chip.nsf")
        convert_body = json.dumps({"songIndex": 0})
        request_headers = {**AUTH_HEADERS, "Content-Type": "application/json"}

        self.client.post(
            "/api/source/convert", headers=request_headers, data=convert_body
        )
        first_render = self.client.post("/api/render", headers=AUTH_HEADERS).get_json()

        self.client.post(
            "/api/source/convert", headers=request_headers, data=convert_body
        )
        second_render = self.client.post("/api/render", headers=AUTH_HEADERS).get_json()

        self.assertGreater(second_render["renderId"], first_render["renderId"])
        self.assertNotEqual(second_render["audioUrl"], first_render["audioUrl"])
        self.assertNotEqual(self.render_calls[1][1], self.render_calls[0][1])

    def test_source_convert_out_of_range_song_index_is_rejected(self) -> None:
        self._upload_source("chip.nsf")
        response = self.client.post(
            "/api/source/convert",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"songIndex": 99}),
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.convert_calls, [])

    def test_source_convert_vgm_conflicting_options_is_rejected(self) -> None:
        self._upload_source("chip.vgm")
        response = self.client.post(
            "/api/source/convert",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"loops": 2, "durationSeconds": 30}),
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.convert_calls, [])

    def test_source_convert_vgm_passes_ch3_special_percussion_option(self) -> None:
        self._upload_source("chip.vgm")
        response = self.client.post(
            "/api/source/convert",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"ch3SpecialPercussion": True}),
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(self.convert_calls), 1)
        fmt, _source_path, _output_path, options = self.convert_calls[0]
        self.assertEqual(fmt.key, "vgm")
        self.assertTrue(options["ch3SpecialPercussion"])

    def test_source_convert_nsf_ignores_client_supplied_loops(self) -> None:
        # NSFはループ点を検出できないため、クライアントがloopsを送っても
        # サーバー側で常に無視される（クライアント側disabledだけを信用しない）。
        self._upload_source("chip.nsf")
        response = self.client.post(
            "/api/source/convert",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"songIndex": 0, "loops": 5}),
        )
        self.assertEqual(response.status_code, 200)
        _fmt, _source_path, _output_path, options = self.convert_calls[0]
        self.assertIsNone(options["loops"])

    def test_source_convert_spc_ignores_client_supplied_duration(self) -> None:
        self._upload_source("chip.spc")
        response = self.client.post(
            "/api/source/convert",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"songIndex": 0, "durationSeconds": 30}),
        )
        self.assertEqual(response.status_code, 200)
        _fmt, _source_path, _output_path, options = self.convert_calls[0]
        self.assertIsNone(options["durationSeconds"])
        self.assertEqual(options["loops"], 1)

    def test_source_convert_without_upload_is_rejected(self) -> None:
        response = self.client.post(
            "/api/source/convert",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({}),
        )
        self.assertEqual(response.status_code, 400)

    def test_source_convert_error_maps_to_502(self) -> None:
        def failing_converter(fmt, source_path, output_path, options) -> None:
            raise ConvertError("変換に失敗しました")

        app = create_app(
            token=TOKEN,
            session=WebSession(),
            list_songs=self.fake_list_songs,
            converter=failing_converter,
        )
        client = app.test_client()
        data = {"source": (io.BytesIO(b"fake source bytes"), "chip.nsf")}
        client.post(
            "/api/source", headers=AUTH_HEADERS, data=data, content_type="multipart/form-data"
        )
        response = client.post(
            "/api/source/convert",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"songIndex": 0}),
        )
        self.assertEqual(response.status_code, 502)
        app.config["MIDITRACK_SESSION"].clear()

    def test_uploading_midi_after_source_clears_source_section(self) -> None:
        self._upload_source("chip.nsf")
        self._upload()
        response = self.client.get("/api/session", headers=AUTH_HEADERS)
        self.assertIsNone(response.get_json()["source"])

    # --- 音源+m3u同梱アップロード ---

    def _upload_files(self, files: list[tuple[bytes, str]]):
        data = {"source": [(io.BytesIO(content), name) for content, name in files]}
        return self.client.post(
            "/api/source", headers=AUTH_HEADERS, data=data, content_type="multipart/form-data"
        )

    def test_bundled_m3u_applies_song_titles(self) -> None:
        m3u = b"chip.nsf,1,Custom Title A\nchip.nsf,2,Custom Title B\n"
        response = self._upload_files([(b"fake nsf bytes", "chip.nsf"), (m3u, "chip.m3u")])
        self.assertEqual(response.status_code, 201)
        payload = response.get_json()
        self.assertTrue(payload["source"]["hasPlaylist"])
        self.assertEqual(payload["source"]["songs"][0]["label"], "Custom Title A")
        self.assertEqual(payload["source"]["songs"][1]["label"], "Custom Title B")
        # 変換候補は音源1つだけなのでファイル選択UIは不要（要素数1）。
        self.assertEqual(len(payload["source"]["files"]), 1)

    def test_loose_upload_ignores_hidden_files(self) -> None:
        response = self._upload_files([
            (b"fake nsf bytes", "chip.nsf"),
            (b"apple double resource fork", "._chip.nsf"),
            (b"finder metadata", ".DS_Store"),
        ])
        self.assertEqual(response.status_code, 201)
        payload = response.get_json()
        self.assertEqual([f["name"] for f in payload["source"]["files"]], ["chip.nsf"])

    def test_m3u_for_unrelated_file_does_not_apply(self) -> None:
        m3u = b"othergame.nsf,1,Unrelated Title\n"
        response = self._upload_files([(b"fake nsf bytes", "chip.nsf"), (m3u, "chip.m3u")])
        payload = response.get_json()
        self.assertTrue(payload["source"]["hasPlaylist"])
        self.assertEqual(payload["source"]["songs"][0]["label"], "Song A")

    def test_m3u_only_upload_is_rejected(self) -> None:
        response = self._upload_files([(b"chip.nsf,1,Title\n", "chip.m3u")])
        self.assertEqual(response.status_code, 400)

    # --- ZIPアップロード ---

    def _upload_zip(self, members: dict[str, bytes], filename: str = "songs.zip"):
        data = {"source": (io.BytesIO(build_zip_bytes(members)), filename)}
        return self.client.post(
            "/api/source", headers=AUTH_HEADERS, data=data, content_type="multipart/form-data"
        )

    def test_zip_with_single_source_file_auto_activates(self) -> None:
        response = self._upload_zip({"chip.nsf": b"fake nsf"})
        self.assertEqual(response.status_code, 201)
        payload = response.get_json()
        self.assertEqual(payload["source"]["format"], "nsf")
        self.assertEqual(len(payload["source"]["files"]), 1)
        # ZIPメンバーはarchive/配下に展開される。
        self.assertEqual(payload["source"]["activeFile"], "archive/chip.nsf")

    def test_zip_with_multiple_source_files_lists_candidates(self) -> None:
        response = self._upload_zip({"a.nsf": b"fake nsf a", "b.nsf": b"fake nsf b"})
        self.assertEqual(response.status_code, 201)
        payload = response.get_json()
        files = payload["source"]["files"]
        self.assertEqual([f["name"] for f in files], ["a.nsf", "b.nsf"])
        # 最初の候補（ファイル名順）が自動選択される。
        self.assertEqual(payload["source"]["activeFile"], "archive/a.nsf")
        self.assertEqual(len(self.list_songs_calls), 1)

    def test_select_file_switches_active_source(self) -> None:
        self._upload_zip({"a.nsf": b"fake nsf a", "b.nsf": b"fake nsf b"})
        response = self.client.post(
            "/api/source/select-file",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"path": "archive/b.nsf"}),
        )
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["source"]["activeFile"], "archive/b.nsf")
        self.assertEqual(len(self.list_songs_calls), 2)
        # ファイル切り替え時点ではまだ変換していないのでトラックは空。
        self.assertEqual(payload["trackCount"], 0)

    def test_select_file_unknown_path_is_rejected(self) -> None:
        self._upload_zip({"a.nsf": b"fake nsf a", "b.nsf": b"fake nsf b"})
        response = self.client.post(
            "/api/source/select-file",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"path": "archive/c.nsf"}),
        )
        self.assertEqual(response.status_code, 400)

    def test_select_file_without_upload_is_rejected(self) -> None:
        response = self.client.post(
            "/api/source/select-file",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"path": "a.nsf"}),
        )
        self.assertEqual(response.status_code, 400)

    def test_zip_ignores_unrelated_members(self) -> None:
        response = self._upload_zip({"chip.nsf": b"fake nsf", "readme.txt": b"read me"})
        self.assertEqual(response.status_code, 201)
        payload = response.get_json()
        self.assertEqual(len(payload["source"]["files"]), 1)

    def test_zip_ignores_macos_hidden_members(self) -> None:
        # macOSでZIPを作成すると__MACOSX/._foo.nsf（AppleDoubleリソースフォーク。
        # 拡張子だけは本体と一致するのでtry_detect_format()単体では弾けない）や
        # .DS_Storeが同梱されがちだが、いずれも候補一覧に出してはいけない。
        response = self._upload_zip({
            "chip.nsf": b"fake nsf",
            "__MACOSX/._chip.nsf": b"apple double resource fork",
            ".DS_Store": b"finder metadata",
        })
        self.assertEqual(response.status_code, 201)
        payload = response.get_json()
        self.assertEqual([f["name"] for f in payload["source"]["files"]], ["chip.nsf"])

    def test_zip_with_playlist_member_applies_titles(self) -> None:
        m3u = b"chip.nsf,1,From Zip A\nchip.nsf,2,From Zip B\n"
        response = self._upload_zip({"chip.nsf": b"fake nsf", "chip.m3u": m3u})
        payload = response.get_json()
        self.assertTrue(payload["source"]["hasPlaylist"])
        self.assertEqual(payload["source"]["songs"][0]["label"], "From Zip A")

    def test_zip_with_no_convertible_members_is_rejected(self) -> None:
        response = self._upload_zip({"readme.txt": b"read me"})
        self.assertEqual(response.status_code, 400)

    def test_invalid_zip_is_rejected(self) -> None:
        data = {"source": (io.BytesIO(b"not a real zip"), "songs.zip")}
        response = self.client.post(
            "/api/source", headers=AUTH_HEADERS, data=data, content_type="multipart/form-data"
        )
        self.assertEqual(response.status_code, 400)

    def test_reupload_after_zip_clears_previous_candidates(self) -> None:
        self._upload_zip({"a.nsf": b"fake nsf a", "b.nsf": b"fake nsf b"})
        response = self._upload_source("chip.nsf")
        self.assertEqual(response.status_code, 201)
        payload = response.get_json()
        self.assertEqual(len(payload["source"]["files"]), 1)
        self.assertFalse(payload["source"]["hasPlaylist"])


class TestWebAppAudioSourceHistory(unittest.TestCase):
    """/api/audio?v=<render_id>がrender_idごとに解決されることのテスト。

    A/Bクロスフェード再生（app.jsのcrossfadeToRender()）は、新しいレンダリングが
    activateされた後も、鳴り続けている旧<audio>要素が旧render_idへRangeリクエストを
    送り続けることを前提にしている。get_audio()がaudio_pathだけを常に返す実装のままだと、
    旧要素が新しいWAVのバイトを受け取ってしまい再生が壊れる。fake_rendererは呼び出し
    回数を埋め込んだ内容・長さの異なるWAVを書くことで、この2つを判別できるようにする。
    """

    def setUp(self) -> None:
        self.render_calls: list[Path] = []

        def fake_renderer(mid_path: Path, wav_path: Path, soundfont: Path | None) -> None:
            self.render_calls.append(wav_path)
            marker = f"RENDER-{len(self.render_calls)}".encode()
            wav_path.write_bytes(marker + b"0" * (100 * len(self.render_calls)))

        self.fake_renderer = fake_renderer
        self.app = create_app(token=TOKEN, session=WebSession(), renderer=fake_renderer)
        self.client = self.app.test_client()
        self.addCleanup(self._clear_session)

    def _clear_session(self) -> None:
        self.app.config["MIDITRACK_SESSION"].clear()

    def _upload(self):
        data = {"midi": (io.BytesIO(build_fixture_bytes()), "fixture.mid")}
        return self.client.post(
            "/api/session", headers=AUTH_HEADERS, data=data, content_type="multipart/form-data"
        )

    def _render(self) -> int:
        response = self.client.post("/api/render", headers=AUTH_HEADERS)
        self.assertEqual(response.status_code, 200)
        return response.get_json()["renderId"]

    def test_old_render_id_keeps_serving_its_own_wav_after_a_new_render(self) -> None:
        self._upload()
        first_id = self._render()
        self.assertEqual(
            self.client.get(f"/api/audio?v={first_id}", headers=AUTH_HEADERS).get_data(),
            b"RENDER-1" + b"0" * 100,
        )

        # トラック設定を変えてinvalidate_render()し、内容の異なる2回目のレンダリングを行う。
        self.client.patch(
            "/api/session/tracks",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"assignments": {"0": 30}}),
        )
        second_id = self._render()
        self.assertNotEqual(first_id, second_id)

        # 新しいrender_idは新しい内容を返す。
        self.assertEqual(
            self.client.get(f"/api/audio?v={second_id}", headers=AUTH_HEADERS).get_data(),
            b"RENDER-2" + b"0" * 200,
        )
        # audio_pathが新音源へ差し替わった後も、旧render_idは旧音源のバイトを返し続ける
        # （クロスフェード中の旧<audio>要素が引き続きこのURLへRangeリクエストを送るため）。
        self.assertEqual(
            self.client.get(f"/api/audio?v={first_id}", headers=AUTH_HEADERS).get_data(),
            b"RENDER-1" + b"0" * 100,
        )
        # ?v無し（サーバー再起動直後の初回ロード等を想定）は常に現在の音源。
        self.assertEqual(
            self.client.get("/api/audio", headers=AUTH_HEADERS).get_data(),
            b"RENDER-2" + b"0" * 200,
        )

    def test_unknown_render_id_falls_back_to_current_audio(self) -> None:
        self._upload()
        self._render()
        response = self.client.get("/api/audio?v=999", headers=AUTH_HEADERS)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_data(), b"RENDER-1" + b"0" * 100)

    def test_old_render_id_survives_range_request_after_a_new_render(self) -> None:
        self._upload()
        first_id = self._render()
        self.client.patch(
            "/api/session/tracks",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"assignments": {"0": 30}}),
        )
        self._render()

        response = self.client.get(
            f"/api/audio?v={first_id}", headers={**AUTH_HEADERS, "Range": "bytes=0-7"}
        )
        self.assertEqual(response.status_code, 206)
        self.assertIn("bytes 0-7/108", response.headers.get("Content-Range", ""))
        self.assertEqual(response.get_data(), b"RENDER-1")

    def test_fresh_upload_clears_old_render_id_resolution(self) -> None:
        self._upload()
        first_id = self._render()
        self._upload()  # reset_midi_state()を経由する新規アップロード。
        response = self.client.get(f"/api/audio?v={first_id}", headers=AUTH_HEADERS)
        self.assertEqual(response.status_code, 400)


class TestWebAppSourceVolume(unittest.TestCase):
    """変換元CC7をトラック音量スライダーの初期値として採用する経路。"""

    def setUp(self) -> None:
        self.render_calls: list[tuple[Path, Path, Path | None]] = []

        def fake_renderer(mid_path: Path, wav_path: Path, soundfont: Path | None) -> None:
            self.render_calls.append((mid_path, wav_path, soundfont))
            wav_path.write_bytes(b"0" * 200)

        self.app = create_app(
            token=TOKEN,
            session=WebSession(),
            renderer=fake_renderer,
        )
        self.client = self.app.test_client()
        self.addCleanup(self._clear_session)

    def _clear_session(self) -> None:
        self.app.config["MIDITRACK_SESSION"].clear()

    def _upload(self, data: bytes, filename: str = "fixture.mid"):
        form = {"midi": (io.BytesIO(data), filename)}
        return self.client.post(
            "/api/session", headers=AUTH_HEADERS, data=form, content_type="multipart/form-data"
        )

    def test_upload_with_attenuating_cc7_seeds_slider_initial_value(self) -> None:
        response = self._upload(build_cc7_fixture_bytes(64))
        payload = response.get_json()
        track = payload["tracks"][0]
        self.assertEqual(track["volumePercent"], 64)
        self.assertEqual(track["sourceVolumePercent"], 64)

    def test_upload_without_cc7_defaults_to_100(self) -> None:
        response = self._upload(build_fixture_bytes())
        track = response.get_json()["tracks"][0]
        self.assertEqual(track["volumePercent"], 100)
        self.assertEqual(track["sourceVolumePercent"], 100)

    def test_render_without_touching_slider_normalizes_cc7_and_scales_velocity(self) -> None:
        self._upload(build_cc7_fixture_bytes(64))
        response = self.client.post("/api/render", headers=AUTH_HEADERS)
        self.assertEqual(response.status_code, 200)

        rendered_midi = mido.MidiFile(self.render_calls[-1][0])
        note_on = next(m for m in rendered_midi.tracks[0] if m.type == "note_on")
        cc7 = next(m for m in rendered_midi.tracks[0] if m.type == "control_change" and m.control == 7)
        self.assertEqual(note_on.velocity, 64)
        self.assertEqual(cc7.value, 100)

    def test_patching_slider_to_baseline_value_is_a_no_op(self) -> None:
        self._upload(build_cc7_fixture_bytes(64))
        response = self.client.patch(
            "/api/session/tracks",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"volumes": {"0": 64}}),
        )
        payload = response.get_json()
        self.assertEqual(payload["tracks"][0]["volumePercent"], 64)
        # baselineと一致する値はセッションのvolumesへ記録されない（100と一致した
        # 場合と同じ「変更なし」扱い）。
        session = self.app.config["MIDITRACK_SESSION"]
        self.assertNotIn(0, session.volumes)

    def test_patching_slider_to_100_is_kept_and_increases_effective_volume(self) -> None:
        self._upload(build_cc7_fixture_bytes(64))
        self.client.patch(
            "/api/session/tracks",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"volumes": {"0": 100}}),
        )
        response = self.client.post("/api/render", headers=AUTH_HEADERS)
        self.assertEqual(response.status_code, 200)

        rendered_midi = mido.MidiFile(self.render_calls[-1][0])
        note_on = next(m for m in rendered_midi.tracks[0] if m.type == "note_on")
        cc7 = next(m for m in rendered_midi.tracks[0] if m.type == "control_change" and m.control == 7)
        self.assertEqual(note_on.velocity, 100)  # baselineではなくユーザー指定の100%
        self.assertEqual(cc7.value, 100)

    def test_fresh_upload_resets_source_volume_baseline(self) -> None:
        self._upload(build_cc7_fixture_bytes(64))
        response = self._upload(build_fixture_bytes())
        track = response.get_json()["tracks"][0]
        self.assertEqual(track["volumePercent"], 100)
        self.assertEqual(track["sourceVolumePercent"], 100)


class TestWebAppChipStem(unittest.TestCase):
    """実機ノイズ/DPCMステム（chipNoise）とensure_render()での合成の挙動。

    render/mix を注入した独自appを使う。既存のTestWebAppはmixerを注入しない
    （chip_stem_pathが無い限りmix_wavは一切呼ばれないことの回帰保証を兼ねる）。
    """

    def setUp(self) -> None:
        self.render_calls: list[tuple[Path, Path, Path | None]] = []
        self.mix_calls: list[tuple[list[tuple[Path, float]], Path]] = []
        self.convert_calls: list[tuple[SourceFormat, Path, Path, dict]] = []

        def fake_renderer(mid_path: Path, wav_path: Path, soundfont: Path | None) -> None:
            self.render_calls.append((mid_path, wav_path, soundfont))
            wav_path.write_bytes(b"D" * 200)

        def fake_mixer(inputs: list[tuple[Path, float]], out_wav: Path) -> None:
            self.mix_calls.append((inputs, out_wav))
            out_wav.write_bytes(b"M" * 300)

        def fake_list_songs(fmt: SourceFormat, source_path: Path):
            return {"Title": "Fake Source"}, [
                {"index": 0, "label": "Song A", "durationSeconds": 30.0, "detail": None}
            ]

        def fake_converter_with_stem(
            fmt: SourceFormat, source_path: Path, output_path: Path, options: dict
        ) -> tuple[Path | None, Path | None]:
            self.convert_calls.append((fmt, source_path, output_path, options))
            output_path.write_bytes(build_fixture_bytes())
            if options.get("chipNoise"):
                stem_path = output_path.with_name(output_path.stem + ".chip.wav")
                stem_path.write_bytes(b"N" * 150)
                return stem_path, None
            return None, None

        self.fake_renderer = fake_renderer
        self.fake_mixer = fake_mixer
        self.fake_list_songs = fake_list_songs
        self.fake_converter_with_stem = fake_converter_with_stem

        self.app = create_app(
            token=TOKEN,
            session=WebSession(),
            renderer=fake_renderer,
            list_songs=fake_list_songs,
            converter=fake_converter_with_stem,
            mixer=fake_mixer,
        )
        self.client = self.app.test_client()
        self.addCleanup(self._clear_session)

    def _clear_session(self) -> None:
        session = self.app.config["MIDITRACK_SESSION"]
        session.clear()

    def _upload_source_with_chip_noise(self):
        data = {"source": (io.BytesIO(b"fake source bytes"), "chip.nsf")}
        self.client.post(
            "/api/source", headers=AUTH_HEADERS, data=data, content_type="multipart/form-data"
        )
        return self.client.post(
            "/api/source/convert",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"songIndex": 0, "chipNoise": True}),
        )

    def test_chip_noise_conversion_sets_has_chip_stem_in_session_payload(self) -> None:
        response = self._upload_source_with_chip_noise()
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertTrue(payload["hasChipStem"])
        # このフィクスチャはNSF chip-wav相当（noiseステムのみ）を模擬しており、
        # YM2612 DACステムは無いVGM専用の別経路 — 別テストで個別に検証する。
        self.assertFalse(payload["hasDacStem"])

    def test_conversion_without_chip_noise_leaves_has_chip_stem_false(self) -> None:
        data = {"source": (io.BytesIO(b"fake source bytes"), "chip.nsf")}
        self.client.post(
            "/api/source", headers=AUTH_HEADERS, data=data, content_type="multipart/form-data"
        )
        response = self.client.post(
            "/api/source/convert",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"songIndex": 0, "chipNoise": False}),
        )
        payload = response.get_json()
        self.assertFalse(payload["hasChipStem"])
        self.assertEqual(self.mix_calls, [])

    def test_ensure_render_mixes_when_stem_present(self) -> None:
        self._upload_source_with_chip_noise()
        response = self.client.post("/api/render", headers=AUTH_HEADERS)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(self.mix_calls), 1)
        self.assertEqual(len(self.render_calls), 1)
        # fluidsynthの出力先は最終WAVではなく一時的な .partN.wav であること。
        dry_target = self.render_calls[0][1]
        self.assertTrue(dry_target.name.endswith(".part0.wav"))
        inputs, out_wav = self.mix_calls[0]
        self.assertNotEqual(dry_target, out_wav)
        # mix_wav() の入力リストの1つ目はfluidsynthの出力（dry）、2つ目はステムであること。
        self.assertEqual(inputs[0][0], dry_target)

    def test_ensure_render_mixes_both_noise_and_dac_stems_when_both_present(self) -> None:
        # 実際のvgm2midiではchipNoiseを1つ有効にするだけで--noise-wav/--dac-wavの
        # 両方を渡すため、曲によっては両方のステムが同時に生成されうる
        # （convert_to_midi()がtuple[Path|None, Path|None]を返す実装）。その場合、
        # dry(fluidsynth) + noiseステム + dacステムの3入力でmix_wav()が呼ばれることを
        # 確認する。
        def fake_converter_with_both_stems(
            fmt: SourceFormat, source_path: Path, output_path: Path, options: dict
        ) -> tuple[Path | None, Path | None]:
            output_path.write_bytes(build_fixture_bytes())
            if not options.get("chipNoise"):
                return None, None
            stem_path = output_path.with_name(output_path.stem + ".chip.wav")
            stem_path.write_bytes(b"N" * 150)
            dac_path = output_path.with_name(output_path.stem + ".dac.wav")
            dac_path.write_bytes(b"D" * 150)
            return stem_path, dac_path

        app = create_app(
            token=TOKEN,
            session=WebSession(),
            renderer=self.fake_renderer,
            list_songs=self.fake_list_songs,
            converter=fake_converter_with_both_stems,
            mixer=self.fake_mixer,
        )
        client = app.test_client()
        data = {"source": (io.BytesIO(b"fake source bytes"), "song.vgm")}
        client.post(
            "/api/source", headers=AUTH_HEADERS, data=data, content_type="multipart/form-data"
        )
        convert_response = client.post(
            "/api/source/convert",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"songIndex": 0, "chipNoise": True}),
        )
        payload = convert_response.get_json()
        self.assertTrue(payload["hasChipStem"])
        self.assertTrue(payload["hasDacStem"])

        response = client.post("/api/render", headers=AUTH_HEADERS)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(self.mix_calls), 1)
        inputs, _out_wav = self.mix_calls[0]
        self.assertEqual(len(inputs), 3)
        self.assertTrue(inputs[1][0].name.endswith(".chip.wav"))
        self.assertTrue(inputs[2][0].name.endswith(".dac.wav"))
        app.config["MIDITRACK_SESSION"].clear()

    def test_dry_wav_is_deleted_after_mixing(self) -> None:
        self._upload_source_with_chip_noise()
        self.client.post("/api/render", headers=AUTH_HEADERS)
        dry_target = self.render_calls[0][1]
        self.assertFalse(dry_target.exists())

    def test_no_stem_means_no_mixer_call(self) -> None:
        # chipNoiseを使わない通常の音源変換では、ffmpegを一切必須依存にしない。
        data = {"source": (io.BytesIO(b"fake source bytes"), "chip.nsf")}
        self.client.post(
            "/api/source", headers=AUTH_HEADERS, data=data, content_type="multipart/form-data"
        )
        self.client.post(
            "/api/source/convert",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"songIndex": 0, "chipNoise": False}),
        )
        response = self.client.post("/api/render", headers=AUTH_HEADERS)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.mix_calls, [])
        self.assertEqual(len(self.render_calls), 1)

    def test_reassigning_instrument_remixes_with_same_stem(self) -> None:
        self._upload_source_with_chip_noise()
        self.client.post("/api/render", headers=AUTH_HEADERS)
        self.assertEqual(len(self.mix_calls), 1)

        self.client.patch(
            "/api/session/tracks",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"assignments": {"0": 30}}),
        )
        response = self.client.post("/api/render", headers=AUTH_HEADERS)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(self.mix_calls), 2)
        # 両方とも同じステムファイルとミックスされている（入力リストの2つ目がステム）。
        self.assertEqual(self.mix_calls[0][0][1][0], self.mix_calls[1][0][1][0])

    def test_uploading_plain_midi_clears_chip_stem_path(self) -> None:
        self._upload_source_with_chip_noise()
        session = self.app.config["MIDITRACK_SESSION"]
        self.assertIsNotNone(session.chip_stem_path)

        data = {"midi": (io.BytesIO(build_fixture_bytes()), "fixture.mid")}
        response = self.client.post(
            "/api/session", headers=AUTH_HEADERS, data=data, content_type="multipart/form-data"
        )
        self.assertEqual(response.status_code, 201)
        self.assertFalse(response.get_json()["hasChipStem"])
        self.assertIsNone(session.chip_stem_path)

    def test_download_wav_receives_mixed_audio(self) -> None:
        self._upload_source_with_chip_noise()

        response = self.client.get("/api/download/wav", headers=AUTH_HEADERS)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data, b"M" * 300)

    def test_variations_sync_stem_per_combination(self) -> None:
        # バッチの各組み合わせは自分自身のspeed/transposeでのみステム同期を判定する
        # （セッション値でも「バッチだから常に同期」でもない）。speed=1.0/transpose=0の
        # 組み合わせでは同期が走らないことが、この判定が正しく個別に行われている証拠。
        pitch_shift_calls: list[tuple[float, float]] = []

        def fake_pitch_shifter(wav_path, work_dir, speeds, pitches):
            pitch_shift_calls.append((speeds[0], pitches[0]))
            out = work_dir / "synced.wav"
            out.write_bytes(b"S" * 120)
            return [out]

        app = create_app(
            token=TOKEN,
            session=WebSession(),
            renderer=self.fake_renderer,
            list_songs=self.fake_list_songs,
            converter=self.fake_converter_with_stem,
            mixer=self.fake_mixer,
            pitch_shifter=fake_pitch_shifter,
        )
        client = app.test_client()
        data = {"source": (io.BytesIO(b"fake source bytes"), "chip.nsf")}
        client.post(
            "/api/source", headers=AUTH_HEADERS, data=data, content_type="multipart/form-data"
        )
        client.post(
            "/api/source/convert",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"songIndex": 0, "chipNoise": True}),
        )
        response = client.post(
            "/api/variations",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"speeds": [1.0, 1.2], "transposes": [0]}),
        )
        self.assertEqual(response.status_code, 200)
        # speed=1.0/transpose=0の組み合わせは既定値なので同期しない。
        # speed=1.2/transpose=0の組み合わせだけが同期される。
        self.assertEqual(pitch_shift_calls, [(1.2, 0.0)])
        app.config["MIDITRACK_SESSION"].clear()

    def test_variations_mix_each_combination(self) -> None:
        # 一部の組み合わせは非既定のspeed/transposeとなりステム同期が必要になるため、
        # setUp()の既定app（pitch_shifter未注入）ではなくfakeを注入したappを使う。
        def fake_pitch_shifter(wav_path, work_dir, speeds, pitches):
            out = work_dir / "synced.wav"
            out.write_bytes(b"S" * 120)
            return [out]

        app = create_app(
            token=TOKEN,
            session=WebSession(),
            renderer=self.fake_renderer,
            list_songs=self.fake_list_songs,
            converter=self.fake_converter_with_stem,
            mixer=self.fake_mixer,
            pitch_shifter=fake_pitch_shifter,
        )
        client = app.test_client()
        data = {"source": (io.BytesIO(b"fake source bytes"), "chip.nsf")}
        client.post(
            "/api/source", headers=AUTH_HEADERS, data=data, content_type="multipart/form-data"
        )
        client.post(
            "/api/source/convert",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"songIndex": 0, "chipNoise": True}),
        )
        response = client.post(
            "/api/variations",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"speeds": [1.0, 1.2], "transposes": [0, 1]}),
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(self.mix_calls), 4)
        app.config["MIDITRACK_SESSION"].clear()

    def test_transform_syncs_stem_before_mixing(self) -> None:
        pitch_shift_calls: list[tuple[Path, Path, list[float], list[float]]] = []

        def fake_pitch_shifter(wav_path, work_dir, speeds, pitches):
            pitch_shift_calls.append((wav_path, work_dir, speeds, pitches))
            out = work_dir / "synced.wav"
            out.write_bytes(b"S" * 120)
            return [out]

        app = create_app(
            token=TOKEN,
            session=WebSession(),
            renderer=self.fake_renderer,
            list_songs=self.fake_list_songs,
            converter=self.fake_converter_with_stem,
            mixer=self.fake_mixer,
            pitch_shifter=fake_pitch_shifter,
        )
        client = app.test_client()
        data = {"source": (io.BytesIO(b"fake source bytes"), "chip.nsf")}
        client.post(
            "/api/source", headers=AUTH_HEADERS, data=data, content_type="multipart/form-data"
        )
        client.post(
            "/api/source/convert",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"songIndex": 0, "chipNoise": True}),
        )
        client.patch(
            "/api/session/transform",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"speed": 1.2, "transpose": -2}),
        )
        response = client.post("/api/render", headers=AUTH_HEADERS)
        self.assertEqual(response.status_code, 200)

        self.assertEqual(len(pitch_shift_calls), 1)
        _wav_path, _work_dir, speeds, pitches = pitch_shift_calls[0]
        self.assertEqual(speeds, [1.2])
        self.assertEqual(pitches, [-2.0])

        inputs, _out_wav = self.mix_calls[0]
        # 2つ目の入力（ステム）は生のchip_stem_pathではなく、同期後のWAVであること。
        self.assertTrue(inputs[1][0].name.endswith("synced.wav"))
        app.config["MIDITRACK_SESSION"].clear()

    def test_default_transform_never_invokes_pitch_shifter_even_with_stem(self) -> None:
        pitch_shift_calls: list[Path] = []

        def fake_pitch_shifter(wav_path, work_dir, speeds, pitches):
            pitch_shift_calls.append(wav_path)
            out = work_dir / "synced.wav"
            out.write_bytes(b"S" * 120)
            return [out]

        app = create_app(
            token=TOKEN,
            session=WebSession(),
            renderer=self.fake_renderer,
            list_songs=self.fake_list_songs,
            converter=self.fake_converter_with_stem,
            mixer=self.fake_mixer,
            pitch_shifter=fake_pitch_shifter,
        )
        client = app.test_client()
        data = {"source": (io.BytesIO(b"fake source bytes"), "chip.nsf")}
        client.post(
            "/api/source", headers=AUTH_HEADERS, data=data, content_type="multipart/form-data"
        )
        client.post(
            "/api/source/convert",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"songIndex": 0, "chipNoise": True}),
        )
        response = client.post("/api/render", headers=AUTH_HEADERS)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(pitch_shift_calls, [])
        self.assertEqual(len(self.mix_calls), 1)
        inputs, _out_wav = self.mix_calls[0]
        self.assertTrue(inputs[1][0].name.endswith(".chip.wav"))  # 生のステムのまま
        app.config["MIDITRACK_SESSION"].clear()

    def test_mix_error_maps_to_502(self) -> None:
        from miditrack.errors import MixError

        def failing_mixer(inputs: list[tuple[Path, float]], out_wav: Path) -> None:
            raise MixError("ffmpegが見つかりません")

        app = create_app(
            token=TOKEN,
            session=WebSession(),
            renderer=self.fake_renderer,
            list_songs=self.fake_list_songs,
            converter=self.fake_converter_with_stem,
            mixer=failing_mixer,
        )
        client = app.test_client()
        data = {"source": (io.BytesIO(b"fake source bytes"), "chip.nsf")}
        client.post(
            "/api/source", headers=AUTH_HEADERS, data=data, content_type="multipart/form-data"
        )
        client.post(
            "/api/source/convert",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"songIndex": 0, "chipNoise": True}),
        )
        response = client.post("/api/render", headers=AUTH_HEADERS)
        self.assertEqual(response.status_code, 502)
        app.config["MIDITRACK_SESSION"].clear()

    def test_track_export_noise_stem_gets_stem_gain_and_transform_sync(self) -> None:
        # 分離不可能な実機ノイズ/DPCMステムは1本のWAVとして_noise_origサフィックス
        # で出力され、mix.STEM_GAINが焼き込まれる。transformが有効なときは
        # ensure_render()と同じくpitch_shift.shで先に同期される。
        pitch_shift_calls: list[tuple[Path, list[float], list[float]]] = []
        gain_calls: list[tuple[Path, float]] = []

        def fake_pitch_shifter(wav_path, work_dir, speeds, pitches):
            pitch_shift_calls.append((wav_path, speeds, pitches))
            out = work_dir / "synced.wav"
            out.write_bytes(wav_path.read_bytes())
            return [out]

        def fake_gain_applier(input_path, output_path, gain):
            gain_calls.append((input_path, gain))
            output_path.write_bytes(input_path.read_bytes())

        app = create_app(
            token=TOKEN,
            session=WebSession(),
            renderer=self.fake_renderer,
            list_songs=self.fake_list_songs,
            converter=self.fake_converter_with_stem,
            mixer=self.fake_mixer,
            pitch_shifter=fake_pitch_shifter,
            gain_applier=fake_gain_applier,
        )
        client = app.test_client()
        data = {"source": (io.BytesIO(b"fake source bytes"), "chip.nsf")}
        client.post(
            "/api/source", headers=AUTH_HEADERS, data=data, content_type="multipart/form-data"
        )
        client.post(
            "/api/source/convert",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"songIndex": 0, "chipNoise": True}),
        )
        client.patch(
            "/api/session/transform",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"speed": 1.2, "transpose": -2}),
        )
        response = client.post("/api/tracks/export", headers=AUTH_HEADERS)
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertIn(("ノイズ/DPCM", "orig"), {(i["track"], i["kind"]) for i in payload["items"]})

        self.assertEqual(len(pitch_shift_calls), 1)
        _wav_path, speeds, pitches = pitch_shift_calls[0]
        self.assertEqual(speeds, [1.2])
        self.assertEqual(pitches, [-2.0])
        # ステム自身にはmix.STEM_GAIN(0.55)、fluidsynthでレンダリングした各トラック
        # （Lead・Noise=ch9パーカッション、計2本）にはhas_stem=Trueによる
        # mix.DRY_GAIN(0.80)が焼き込まれる。
        gains = sorted(gain for _path, gain in gain_calls)
        self.assertEqual(gains, sorted([mix.STEM_GAIN, mix.DRY_GAIN, mix.DRY_GAIN]))
        download = client.get("/api/download/tracks", headers=AUTH_HEADERS)
        archive = zipfile.ZipFile(io.BytesIO(download.data))
        self.assertIn("chip_00_noise_orig.wav", archive.namelist())
        app.config["MIDITRACK_SESSION"].clear()


def build_single_track_fixture_bytes() -> bytes:
    """percussion等の編集不可トラックを含まない、単一メロディックトラックのフィクスチャ。

    「唯一の音が鳴るトラックを手動指定すると、ゲーム側に残るトラックが無くなる」
    ケースの検証専用。build_fixture_bytes()は常にtrack1(パーカッション)を含むため
    このケースを再現できない。
    """
    mf = mido.MidiFile(ticks_per_beat=480)
    t0 = mido.MidiTrack()
    t0.append(mido.MetaMessage("track_name", name="Lead", time=0))
    t0.append(mido.Message("program_change", program=38, channel=0, time=0))
    t0.append(mido.Message("note_on", note=60, velocity=100, channel=0, time=0))
    t0.append(mido.Message("note_off", note=60, velocity=0, channel=0, time=480))
    mf.tracks.append(t0)
    buffer = io.BytesIO()
    mf.save(file=buffer)
    return buffer.getvalue()


class TestWebAppGameSoundfont(unittest.TestCase):
    """gameSoundfont（spc2midi --sf2 によるゲーム由来SoundFont）とensure_render()の挙動。

    build_fixture_bytes()はtrack0(ch0, 編集可能)とtrack1(ch9パーカッション, 編集不可)
    の2トラック構成。track0を手動指定してもtrack1(常にゲーム側)に音が残るため、
    実際に分割・ミックスが発生する — これがフェーズ4の実装が意図する挙動そのもの。
    render/mixを注入した独自appを使う。
    """

    CLI_SOUNDFONT = Path("/fake/cli-default.sf2")

    def setUp(self) -> None:
        self.render_calls: list[tuple[Path, Path, Path | None]] = []
        self.mix_calls: list[tuple[list[tuple[Path, float]], Path]] = []
        self.convert_calls: list[tuple[SourceFormat, Path, Path, dict]] = []
        self.render_delay = 0.0
        self.active_renderers = 0
        self.max_active_renderers = 0
        self.renderer_lock = threading.Lock()

        def fake_renderer(mid_path: Path, wav_path: Path, soundfont: Path | None) -> None:
            with self.renderer_lock:
                self.active_renderers += 1
                self.max_active_renderers = max(
                    self.max_active_renderers, self.active_renderers
                )
            try:
                self.render_calls.append((mid_path, wav_path, soundfont))
                if self.render_delay:
                    time.sleep(self.render_delay)
                wav_path.write_bytes(b"D" * 200)
            finally:
                with self.renderer_lock:
                    self.active_renderers -= 1

        def fake_mixer(inputs: list[tuple[Path, float]], out_wav: Path) -> None:
            self.mix_calls.append((inputs, out_wav))
            out_wav.write_bytes(b"M" * 300)

        def fake_list_songs(fmt: SourceFormat, source_path: Path):
            return {"Title": "Fake Source"}, [
                {"index": 0, "label": "Song A", "durationSeconds": 30.0, "detail": None}
            ]

        def fake_converter_with_sf2(
            fmt: SourceFormat, source_path: Path, output_path: Path, options: dict
        ) -> tuple[Path | None, Path | None]:
            # 実際のspc2midiは --sf2 をgameSoundfontの有無に関わらず常に要求する
            # （convert.py _build_argv()参照）ため、このフェイクもオプション値に
            # 関わらず常にSF2を書き出す。
            self.convert_calls.append((fmt, source_path, output_path, options))
            output_path.write_bytes(build_fixture_bytes())
            sf2_path = output_path.with_suffix(".sf2")
            sf2_path.write_bytes(b"S" * 150)
            return None, None

        self.fake_renderer = fake_renderer
        self.fake_mixer = fake_mixer
        self.fake_list_songs = fake_list_songs
        self.fake_converter_with_sf2 = fake_converter_with_sf2

        self.app = create_app(
            token=TOKEN,
            session=WebSession(),
            soundfont=self.CLI_SOUNDFONT,
            renderer=fake_renderer,
            list_songs=fake_list_songs,
            converter=fake_converter_with_sf2,
            mixer=fake_mixer,
        )
        self.client = self.app.test_client()
        self.addCleanup(self._clear_session)

    def _clear_session(self) -> None:
        session = self.app.config["MIDITRACK_SESSION"]
        session.clear()

    def _upload_source_with_game_soundfont(self):
        data = {"source": (io.BytesIO(b"fake source bytes"), "song.spc")}
        self.client.post(
            "/api/source", headers=AUTH_HEADERS, data=data, content_type="multipart/form-data"
        )
        return self.client.post(
            "/api/source/convert",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"songIndex": 0, "gameSoundfont": True}),
        )

    def _assign_track0(self) -> None:
        self.client.patch(
            "/api/session/tracks",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"assignments": {"0": 30}}),
        )

    def test_conversion_sets_has_game_soundfont_in_session_payload(self) -> None:
        response = self._upload_source_with_game_soundfont()
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.get_json()["hasGameSoundfont"])

    def test_game_soundfont_tracks_expose_explicit_source_choices(self) -> None:
        response = self._upload_source_with_game_soundfont()
        payload = response.get_json()

        self.assertEqual(
            [track["source"] for track in payload["tracks"]],
            ["game", "game"],
        )
        self.assertEqual(
            [track["availableSources"] for track in payload["tracks"]],
            [["soundfont", "game"], ["soundfont", "game"]],
        )
        self.assertTrue(all(track["volumeEditable"] for track in payload["tracks"]))

    def test_source_patch_to_soundfont_selects_safe_default_gm_program(self) -> None:
        self._upload_source_with_game_soundfont()
        response = self.client.patch(
            "/api/session/tracks",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"sources": {"0": "soundfont"}}),
        )

        self.assertEqual(response.status_code, 200)
        track = response.get_json()["tracks"][0]
        self.assertEqual(track["source"], "soundfont")
        self.assertEqual(track["assignedProgram"], 80)

        render_response = self.client.post("/api/render", headers=AUTH_HEADERS)
        self.assertEqual(render_response.status_code, 200)
        self.assertEqual(len(self.render_calls), 2)
        session = self.app.config["MIDITRACK_SESSION"]
        self.assertEqual(
            {call[2] for call in self.render_calls},
            {session.game_soundfont_path, self.CLI_SOUNDFONT},
        )

    def test_two_soundfont_parts_render_in_parallel(self) -> None:
        self._upload_source_with_game_soundfont()
        self._assign_track0()
        self.render_delay = 0.05

        response = self.client.post("/api/render", headers=AUTH_HEADERS)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(self.render_calls), 2)
        self.assertEqual(self.max_active_renderers, 2)

    def test_switching_back_to_game_keeps_volume_and_original_program(self) -> None:
        self._upload_source_with_game_soundfont()
        self.client.patch(
            "/api/session/tracks",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps(
                {"sources": {"0": "soundfont"}, "assignments": {"0": 30}}
            ),
        )
        response = self.client.patch(
            "/api/session/tracks",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"sources": {"0": "game"}, "volumes": {"0": 150}}),
        )

        self.assertEqual(response.status_code, 200)
        track = response.get_json()["tracks"][0]
        self.assertEqual(track["source"], "game")
        self.assertEqual(track["assignedProgram"], 30)
        self.assertEqual(track["volumePercent"], 150)

        render_response = self.client.post("/api/render", headers=AUTH_HEADERS)
        self.assertEqual(render_response.status_code, 200)
        self.assertEqual(len(self.render_calls), 1)
        session = self.app.config["MIDITRACK_SESSION"]
        self.assertEqual(self.render_calls[0][2], session.game_soundfont_path)

        applied = mido.MidiFile(session.applied_path)
        program_changes = [
            message.program
            for message in applied.tracks[0]
            if message.type == "program_change"
        ]
        note_velocities = [
            message.velocity
            for message in applied.tracks[0]
            if message.type == "note_on" and message.velocity > 0
        ]
        self.assertEqual(program_changes, [80])
        self.assertEqual(note_velocities, [127])

    def test_conversion_without_option_still_offers_game_but_defaults_to_soundfont(self) -> None:
        # gameSoundfontは「音符のある全トラックを初期選択するか」だけを制御する
        # サジェストであり、SoundFont自体の生成（--sf2）はNSF/VGMの
        # --track-metadataと同じく常に行われる。チェックを外しても"game"は
        # 選択肢として残り、ただし初期選択（source）は"soundfont"のままになる。
        data = {"source": (io.BytesIO(b"fake source bytes"), "song.spc")}
        self.client.post(
            "/api/source", headers=AUTH_HEADERS, data=data, content_type="multipart/form-data"
        )
        response = self.client.post(
            "/api/source/convert",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"songIndex": 0, "gameSoundfont": False}),
        )
        payload = response.get_json()
        self.assertTrue(payload["hasGameSoundfont"])
        self.assertEqual([track["source"] for track in payload["tracks"]], ["soundfont", "soundfont"])
        self.assertEqual(
            [track["availableSources"] for track in payload["tracks"]],
            [["soundfont", "game"], ["soundfont", "game"]],
        )
        self.assertTrue(all(track["sourceSuggested"] for track in payload["tracks"]))

    def test_render_with_no_assignments_uses_game_soundfont_once(self) -> None:
        self._upload_source_with_game_soundfont()
        response = self.client.post("/api/render", headers=AUTH_HEADERS)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(self.render_calls), 1)
        self.assertEqual(self.mix_calls, [])
        used_soundfont = self.render_calls[0][2]
        self.assertEqual(used_soundfont, self.app.config["MIDITRACK_SESSION"].game_soundfont_path)
        self.assertNotEqual(used_soundfont, self.CLI_SOUNDFONT)
        # applied_pathをそのままレンダリングするので、分割用の.game.mid/.gm.midは作られない。
        session = self.app.config["MIDITRACK_SESSION"]
        self.assertEqual(list(session.root.glob("*.game.mid")), [])
        self.assertEqual(list(session.root.glob("*.gm.mid")), [])

    def test_render_with_one_assignment_splits_into_two_renders(self) -> None:
        self._upload_source_with_game_soundfont()
        self._assign_track0()
        response = self.client.post("/api/render", headers=AUTH_HEADERS)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(self.render_calls), 2)
        self.assertEqual(len(self.mix_calls), 1)

        session = self.app.config["MIDITRACK_SESSION"]
        soundfonts_used = {call[2] for call in self.render_calls}
        self.assertEqual(soundfonts_used, {session.game_soundfont_path, self.CLI_SOUNDFONT})

        inputs, _out_wav = self.mix_calls[0]
        # ゲームSF2側/GM側どちらもヘッドルームを取らない(SPLIT_GAIN=1.0)。
        self.assertEqual([gain for _path, gain in inputs], [1.0, 1.0])

    def test_split_midis_and_part_wavs_are_deleted_after_render(self) -> None:
        self._upload_source_with_game_soundfont()
        self._assign_track0()
        self.client.post("/api/render", headers=AUTH_HEADERS)
        session = self.app.config["MIDITRACK_SESSION"]
        self.assertEqual(list(session.root.glob("*.game.mid")), [])
        self.assertEqual(list(session.root.glob("*.gm.mid")), [])
        self.assertEqual(list(session.root.glob("*.part*.wav")), [])
        # 分割前のapplied_path（/api/downloadが参照する)は消してはいけない。
        self.assertTrue(session.applied_path.exists())

    def test_clearing_assignment_returns_to_single_game_render(self) -> None:
        self._upload_source_with_game_soundfont()
        self._assign_track0()
        self.client.post("/api/render", headers=AUTH_HEADERS)
        self.assertEqual(len(self.render_calls), 2)  # 分割された1回分（2ジョブ）

        self.client.patch(
            "/api/session/tracks",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"assignments": {"0": None}}),
        )
        response = self.client.post("/api/render", headers=AUTH_HEADERS)
        self.assertEqual(response.status_code, 200)
        # 手動指定を解除すると単一ジョブに戻り、render_callsは1件だけ増える。
        self.assertEqual(len(self.render_calls), 3)
        self.assertEqual(
            self.render_calls[2][2], self.app.config["MIDITRACK_SESSION"].game_soundfont_path
        )

    def test_all_tracks_assigned_falls_back_to_single_gm_render(self) -> None:
        # ゲーム側に鳴るトラックが1つも無くなる場合（唯一の編集可能トラックを
        # 手動指定し、他に編集不可トラックも無い場合）は分割せず、GM SoundFontで
        # 1回だけレンダリングする。
        def fake_converter_single_track(
            fmt: SourceFormat, source_path: Path, output_path: Path, options: dict
        ) -> tuple[Path | None, Path | None]:
            output_path.write_bytes(build_single_track_fixture_bytes())
            if options.get("gameSoundfont"):
                output_path.with_suffix(".sf2").write_bytes(b"S" * 150)
            return None, None

        app = create_app(
            token=TOKEN,
            session=WebSession(),
            soundfont=self.CLI_SOUNDFONT,
            renderer=self.fake_renderer,
            list_songs=self.fake_list_songs,
            converter=fake_converter_single_track,
            mixer=self.fake_mixer,
        )
        client = app.test_client()
        data = {"source": (io.BytesIO(b"fake source bytes"), "song.spc")}
        client.post(
            "/api/source", headers=AUTH_HEADERS, data=data, content_type="multipart/form-data"
        )
        client.post(
            "/api/source/convert",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"songIndex": 0, "gameSoundfont": True}),
        )
        client.patch(
            "/api/session/tracks",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"assignments": {"0": 30}}),
        )
        response = client.post("/api/render", headers=AUTH_HEADERS)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(self.render_calls), 1)
        self.assertEqual(self.mix_calls, [])
        self.assertEqual(self.render_calls[0][2], self.CLI_SOUNDFONT)
        app.config["MIDITRACK_SESSION"].clear()

    def test_soundfont_override_applies_only_to_gm_side(self) -> None:
        self._upload_source_with_game_soundfont()
        with tempfile.TemporaryDirectory() as tmp:
            override = Path(tmp) / "override.sf2"
            override.write_bytes(b"0")
            self.client.post(
                "/api/soundfont",
                headers={**AUTH_HEADERS, "Content-Type": "application/json"},
                data=json.dumps({"path": str(override)}),
            )
            self._assign_track0()
            response = self.client.post("/api/render", headers=AUTH_HEADERS)
            self.assertEqual(response.status_code, 200)

            session = self.app.config["MIDITRACK_SESSION"]
            soundfonts_used = {call[2] for call in self.render_calls}
            # GM側はCLIデフォルトではなくoverrideを使う。ゲーム側は変わらずgame_soundfont_path。
            self.assertEqual(soundfonts_used, {session.game_soundfont_path, override})
            self.assertNotIn(self.CLI_SOUNDFONT, soundfonts_used)

    def test_missing_sf2_falls_back_to_gm_render(self) -> None:
        # instrSets()が空などでSF2が生成されなかった状況を模擬する。
        def fake_converter_without_sf2(
            fmt: SourceFormat, source_path: Path, output_path: Path, options: dict
        ) -> tuple[Path | None, Path | None]:
            output_path.write_bytes(build_fixture_bytes())
            return None, None

        app = create_app(
            token=TOKEN,
            session=WebSession(),
            soundfont=self.CLI_SOUNDFONT,
            renderer=self.fake_renderer,
            list_songs=self.fake_list_songs,
            converter=fake_converter_without_sf2,
            mixer=self.fake_mixer,
        )
        client = app.test_client()
        data = {"source": (io.BytesIO(b"fake source bytes"), "song.spc")}
        client.post(
            "/api/source", headers=AUTH_HEADERS, data=data, content_type="multipart/form-data"
        )
        response = client.post(
            "/api/source/convert",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"songIndex": 0, "gameSoundfont": True}),
        )
        self.assertFalse(response.get_json()["hasGameSoundfont"])
        render_response = client.post("/api/render", headers=AUTH_HEADERS)
        self.assertEqual(render_response.status_code, 200)
        self.assertEqual(len(self.render_calls), 1)
        self.assertEqual(self.mix_calls, [])
        self.assertEqual(self.render_calls[0][2], self.CLI_SOUNDFONT)
        app.config["MIDITRACK_SESSION"].clear()

    def test_uploading_plain_midi_clears_game_soundfont_path(self) -> None:
        self._upload_source_with_game_soundfont()
        session = self.app.config["MIDITRACK_SESSION"]
        self.assertIsNotNone(session.game_soundfont_path)

        data = {"midi": (io.BytesIO(build_fixture_bytes()), "fixture.mid")}
        response = self.client.post(
            "/api/session", headers=AUTH_HEADERS, data=data, content_type="multipart/form-data"
        )
        self.assertEqual(response.status_code, 201)
        self.assertFalse(response.get_json()["hasGameSoundfont"])
        self.assertIsNone(session.game_soundfont_path)

    def test_download_returns_combined_pre_split_midi(self) -> None:
        self._upload_source_with_game_soundfont()
        self._assign_track0()
        self.client.post("/api/render", headers=AUTH_HEADERS)
        response = self.client.get("/api/download", headers=AUTH_HEADERS)
        self.assertEqual(response.status_code, 200)
        session = self.app.config["MIDITRACK_SESSION"]
        self.assertEqual(response.data, session.applied_path.read_bytes())

    # --- トラックごとに出力（ゲーム由来SoundFont） ---

    def test_track_export_uses_game_soundfont_when_no_assignment(self) -> None:
        # 既定状態（未割り当て）ではSPCの両トラックとも"game"＝ゲーム由来
        # SoundFontレンダリングなので、どちらも_origサフィックスになる。
        self._upload_source_with_game_soundfont()
        response = self.client.post("/api/tracks/export", headers=AUTH_HEADERS)
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(
            {(item["track"], item["kind"]) for item in payload["items"]},
            {("Lead", "orig"), ("Noise", "orig")},
        )
        for _mid, _wav, sf in self.render_calls:
            self.assertTrue(str(sf).endswith(".sf2"))

    def test_track_export_splits_by_source_after_assignment(self) -> None:
        # track0を手動でGM音色に割り当てると"soundfont"側（_midi）へ移り、
        # track1（常にゲーム側）は_origのまま。CLI既定SoundFontが使われる。
        self._upload_source_with_game_soundfont()
        self._assign_track0()
        response = self.client.post("/api/tracks/export", headers=AUTH_HEADERS)
        payload = response.get_json()
        kinds = {(item["track"], item["kind"]) for item in payload["items"]}
        self.assertEqual(kinds, {("Lead", "midi"), ("Noise", "orig")})
        used_soundfonts = {sf for _mid, _wav, sf in self.render_calls}
        self.assertIn(self.CLI_SOUNDFONT, used_soundfonts)
        self.assertTrue(any(str(sf).endswith(".sf2") for sf in used_soundfonts))
        # ステム併用が無いため(has_stem=False)、ffmpegによるゲイン適用は
        # 一切発生しない（mixerも呼ばれない）。
        self.assertEqual(self.mix_calls, [])


class TestWebAppLibvgmTrackSource(unittest.TestCase):
    """VGM sidecarの自動サジェスト・音源PATCH・選択レンダリング。"""

    def setUp(self) -> None:
        self.libvgm_calls: list[tuple[Path, Path, int, list]] = []
        self.render_calls: list[tuple[Path, Path, Path | None]] = []
        self.render_note_counts: list[int] = []
        self.mix_calls: list[list[tuple[Path, float]]] = []
        self.gain_calls: list[tuple[Path, float]] = []
        self.render_delay = 0.0
        self.active_render_jobs = 0
        self.max_active_render_jobs = 0
        self.render_job_lock = threading.Lock()

        def begin_render_job() -> None:
            with self.render_job_lock:
                self.active_render_jobs += 1
                self.max_active_render_jobs = max(
                    self.max_active_render_jobs, self.active_render_jobs
                )

        def end_render_job() -> None:
            with self.render_job_lock:
                self.active_render_jobs -= 1

        def fake_converter(_fmt, _source, output_path, _options):
            output_path.write_bytes(build_fixture_bytes())
            libvgm.metadata_path_for(output_path).write_text(json.dumps({
                "version": 1,
                "sampleCount": 44100,
                "tracks": [
                    {"trackIndex": 0, "libvgm": {
                        "deviceType": 0, "instance": 0, "mainMask": 1,
                        "linkedMask": 0, "groupId": "tone-0",
                        "suggestedForHardwareMix": False,
                    }},
                    {"trackIndex": 1, "libvgm": {
                        "deviceType": 0, "instance": 0, "mainMask": 8,
                        "linkedMask": 0, "groupId": "noise-3",
                        "suggestedForHardwareMix": True,
                    }},
                ],
            }), encoding="utf-8")
            return None, None

        def fake_libvgm(source, output, sample_count, targets):
            begin_render_job()
            try:
                self.libvgm_calls.append((source, output, sample_count, targets))
                if self.render_delay:
                    time.sleep(self.render_delay)
                output.write_bytes(b"L" * 200)
            finally:
                end_render_job()

        def fake_renderer(mid_path, wav_path, soundfont):
            begin_render_job()
            try:
                self.render_calls.append((mid_path, wav_path, soundfont))
                dry_midi = mido.MidiFile(mid_path)
                self.render_note_counts.append(sum(
                    msg.type == "note_on" and msg.velocity > 0
                    for track in dry_midi.tracks for msg in track
                ))
                if self.render_delay:
                    time.sleep(self.render_delay)
                wav_path.write_bytes(b"D" * 200)
            finally:
                end_render_job()

        def fake_mixer(inputs, output):
            self.mix_calls.append(inputs)
            output.write_bytes(b"M" * 200)

        # バリエーション一括生成で既定値以外のspeed/transposeを含む組み合わせを
        # 使うテストが、実物のpitch_shift.sh(rubberband)を起動してこのダミー
        # WAVを読ませてしまわないよう注入する。
        def fake_pitch_shifter(wav_path, work_dir, _speeds, _pitches):
            out = work_dir / "synced.wav"
            out.write_bytes(wav_path.read_bytes())
            return [out]

        # 「トラックごとに出力」（POST /api/tracks/export）のゲイン焼き込み
        # （mix.apply_gain）を注入で差し替える。実ffmpegを起動しないため。
        def fake_gain_applier(input_path, output_path, gain):
            self.gain_calls.append((input_path, gain))
            output_path.write_bytes(input_path.read_bytes())

        self.fake_gain_applier = fake_gain_applier

        self.app = create_app(
            token=TOKEN,
            session=WebSession(),
            converter=fake_converter,
            renderer=fake_renderer,
            mixer=fake_mixer,
            gain_applier=fake_gain_applier,
            libvgm_renderer=fake_libvgm,
            pitch_shifter=fake_pitch_shifter,
        )
        self.client = self.app.test_client()
        self.addCleanup(self.app.config["MIDITRACK_SESSION"].clear)

    def _convert(self, chip_noise: bool):
        self.client.post(
            "/api/source",
            headers=AUTH_HEADERS,
            data={"source": (io.BytesIO(b"fake-vgm"), "song.vgm")},
            content_type="multipart/form-data",
        )
        return self.client.post(
            "/api/source/convert",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"chipNoise": chip_noise}),
        )

    def test_checked_option_auto_selects_only_suggested_track(self) -> None:
        payload = self._convert(True).get_json()
        self.assertEqual(payload["tracks"][0]["source"], "soundfont")
        self.assertEqual(payload["tracks"][1]["source"], "game")
        self.assertTrue(payload["tracks"][1]["sourceSuggested"])
        self.assertEqual(payload["tracks"][1]["availableSources"], ["soundfont", "game"])

    def test_selection_renders_libvgm_and_removes_midi_track_from_dry_mix(self) -> None:
        self._convert(True)
        response = self.client.post("/api/render", headers=AUTH_HEADERS)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(self.libvgm_calls), 1)
        self.assertEqual(self.libvgm_calls[0][2], 44100)
        self.assertEqual(len(self.render_calls), 1)
        self.assertEqual(self.render_note_counts, [1])
        self.assertEqual(len(self.mix_calls[0]), 2)

    def test_chip_and_fluidsynth_jobs_share_two_worker_pool(self) -> None:
        self._convert(True)
        self.render_delay = 0.05

        response = self.client.post("/api/render", headers=AUTH_HEADERS)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(self.libvgm_calls), 1)
        self.assertEqual(len(self.render_calls), 1)
        self.assertEqual(self.max_active_render_jobs, 2)

    def test_source_patch_switches_a_supported_track(self) -> None:
        self._convert(False)
        response = self.client.patch(
            "/api/session/tracks",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"sources": {"0": "game"}}),
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["tracks"][0]["source"], "game")

    def test_default_volume_game_tracks_render_libvgm_once(self) -> None:
        # 両トラックとも音量が既定(100%)のままなら、従来どおりまとめて1回の
        # レンダリング呼び出しになる（音量調整によるレンダリング回数増加が
        # 起きない、という回帰ガード）。
        self._convert(False)
        self.client.patch(
            "/api/session/tracks",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"sources": {"0": "game", "1": "game"}}),
        )
        response = self.client.post("/api/render", headers=AUTH_HEADERS)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(self.libvgm_calls), 1)
        self.assertEqual({t.group_id for t in self.libvgm_calls[0][3]}, {"tone-0", "noise-3"})

    def test_custom_volume_game_track_is_rendered_individually(self) -> None:
        # 音量を変更したチャンネルだけ個別にレンダリングし、既定音量のままの
        # チャンネルは引き続きまとめて1回——チャンネル数分の再エミュレーション
        # コストを、実際に音量調整したチャンネルだけに限定する設計。
        self._convert(False)
        self.client.patch(
            "/api/session/tracks",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({
                "sources": {"0": "game", "1": "game"},
                "volumes": {"1": 150},
            }),
        )
        response = self.client.post("/api/render", headers=AUTH_HEADERS)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(self.libvgm_calls), 2)
        default_call = next(c for c in self.libvgm_calls if len(c[3]) == 1 and c[3][0].group_id == "tone-0")
        custom_call = next(c for c in self.libvgm_calls if len(c[3]) == 1 and c[3][0].group_id == "noise-3")
        self.assertIsNotNone(default_call)
        self.assertIsNotNone(custom_call)
        # mix_wav()の入力に、音量150%を反映したゲイン(STEM_GAIN*1.5)が
        # 含まれていること。
        gains = [round(gain, 6) for _path, gain in self.mix_calls[0]]
        self.assertIn(round(mix.STEM_GAIN * 1.5, 6), gains)
        self.assertIn(round(mix.STEM_GAIN, 6), gains)

    def test_changing_custom_volume_reuses_raw_chip_stems(self) -> None:
        self._convert(False)
        self.client.patch(
            "/api/session/tracks",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({
                "sources": {"0": "game", "1": "game"},
                "volumes": {"1": 150},
            }),
        )
        self.client.post("/api/render", headers=AUTH_HEADERS)
        self.assertEqual(len(self.libvgm_calls), 2)

        self.client.patch(
            "/api/session/tracks",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"volumes": {"1": 120}}),
        )
        self.client.post("/api/render", headers=AUTH_HEADERS)

        # 既定グループと個別チャンネルの選択集合は同じなので、生WAVは再利用される。
        self.assertEqual(len(self.libvgm_calls), 2)
        latest_gains = [round(gain, 6) for _path, gain in self.mix_calls[-1]]
        self.assertIn(round(mix.STEM_GAIN * 1.2, 6), latest_gains)

    def test_all_custom_volume_game_tracks_render_individually_only(self) -> None:
        # 全チャンネルの音量を変更した場合、既定音量グループは空になり、
        # チャンネルごとの個別レンダリングだけになる。
        self._convert(False)
        self.client.patch(
            "/api/session/tracks",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({
                "sources": {"0": "game", "1": "game"},
                "volumes": {"0": 50, "1": 150},
            }),
        )
        response = self.client.post("/api/render", headers=AUTH_HEADERS)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(self.libvgm_calls), 2)
        self.assertTrue(all(len(call[3]) == 1 for call in self.libvgm_calls))
        gains = sorted(round(gain, 6) for _path, gain in self.mix_calls[0])
        self.assertEqual(gains, sorted([round(mix.STEM_GAIN * 0.5, 6), round(mix.STEM_GAIN * 1.5, 6)]))

    def test_variations_reuse_individually_rendered_chip_stems_across_combinations(self) -> None:
        # バリエーション一括生成でも、音量調整で個別レンダリングされた
        # チャンネルは全組み合わせで使い回される（組み合わせの数だけ
        # libvgmが呼ばれることはない）。
        self._convert(False)
        self.client.patch(
            "/api/session/tracks",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({
                "sources": {"0": "game", "1": "game"},
                "volumes": {"1": 150},
            }),
        )
        response = self.client.post(
            "/api/variations",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"speeds": [1.0, 1.2], "transposes": [0]}),
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.get_json()["items"]), 2)
        # デフォルトグループ1回＋カスタムチャンネル1回＝2回のみ。2組み合わせ分
        # 増えたりはしない。
        self.assertEqual(len(self.libvgm_calls), 2)

    # --- トラックごとに出力（実機チップチャンネル） ---

    def test_track_export_default_renders_chip_channel_individually(self) -> None:
        self._convert(True)
        response = self.client.post("/api/tracks/export", headers=AUTH_HEADERS)
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        kinds = {(item["track"], item["kind"]) for item in payload["items"]}
        self.assertEqual(kinds, {("Lead", "midi"), ("Noise", "orig")})
        self.assertEqual(len(self.libvgm_calls), 1)
        download = self.client.get("/api/download/tracks", headers=AUTH_HEADERS)
        archive = zipfile.ZipFile(io.BytesIO(download.data))
        self.assertEqual(
            set(archive.namelist()), {"song_Lead_midi.wav", "song_Noise_orig.wav"}
        )
        # 実機チップチャンネル(has_stem=True)があるため、fluidsynth側にも
        # mix.DRY_GAINが焼き込まれる（_render_applied_midi()と同じ規則）。
        # Lead(fluidsynth、DRY_GAIN)+Noise(チップチャンネル、STEM_GAIN)で2回。
        self.assertEqual(len(self.gain_calls), 2)

    def test_track_export_grouped_combines_chip_channels_into_one_file(self) -> None:
        self._convert(True)
        response = self.client.post(
            "/api/tracks/export",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"groupChipTracks": True}),
        )
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(
            {(item["track"], item["kind"]) for item in payload["items"]},
            {("Lead", "midi"), ("原曲の音源（まとめ）", "orig")},
        )
        download = self.client.get("/api/download/tracks", headers=AUTH_HEADERS)
        archive = zipfile.ZipFile(io.BytesIO(download.data))
        self.assertEqual(
            set(archive.namelist()), {"song_Lead_midi.wav", "song_chiptracks_orig.wav"}
        )

    def test_track_export_excludes_muted_chip_channel(self) -> None:
        self._convert(True)
        self.client.patch(
            "/api/session/tracks",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"volumes": {"1": 0}}),
        )
        response = self.client.post("/api/tracks/export", headers=AUTH_HEADERS)
        payload = response.get_json()
        self.assertEqual([item["track"] for item in payload["items"]], ["Lead"])
        # 実機チップチャンネルのレンダリング自体は_plan_chip_hardware()の
        # 通常挙動どおり発生する（音量0ゲインで計画されるだけ）が、ZIPからは
        # 除外される。


class TestWebAppChipHardwareVolumeBaseline(unittest.TestCase):
    """「原曲の音源」レンダリングのゲインが、変換元CC7由来のbaselineを基準にした
    相対値になること（web.py _render_chip_hardware()）。baseline=100%のケースは
    TestWebAppLibvgmTrackSourceの各テストが既に回帰保証している。
    """

    def setUp(self) -> None:
        self.libvgm_calls: list[tuple[Path, Path, int, list]] = []
        self.mix_calls: list[list[tuple[Path, float]]] = []

        def fake_converter(_fmt, _source, output_path, _options):
            output_path.write_bytes(build_two_track_cc7_fixture_bytes(64))
            libvgm.metadata_path_for(output_path).write_text(json.dumps({
                "version": 1,
                "sampleCount": 44100,
                "tracks": [
                    {"trackIndex": 0, "libvgm": {
                        "deviceType": 0, "instance": 0, "mainMask": 1,
                        "linkedMask": 0, "groupId": "tone-0",
                        "suggestedForHardwareMix": True,
                    }},
                ],
            }), encoding="utf-8")
            return None, None

        def fake_libvgm(source, output, sample_count, targets):
            self.libvgm_calls.append((source, output, sample_count, targets))
            output.write_bytes(b"L" * 200)

        def fake_renderer(mid_path, wav_path, soundfont):
            wav_path.write_bytes(b"D" * 200)

        def fake_mixer(inputs, output):
            self.mix_calls.append(inputs)
            output.write_bytes(b"M" * 200)

        self.app = create_app(
            token=TOKEN,
            session=WebSession(),
            converter=fake_converter,
            renderer=fake_renderer,
            mixer=fake_mixer,
            libvgm_renderer=fake_libvgm,
        )
        self.client = self.app.test_client()
        self.addCleanup(self.app.config["MIDITRACK_SESSION"].clear)

    def _convert_and_select_game(self) -> None:
        self.client.post(
            "/api/source",
            headers=AUTH_HEADERS,
            data={"source": (io.BytesIO(b"fake-vgm"), "song.vgm")},
            content_type="multipart/form-data",
        )
        self.client.post(
            "/api/source/convert",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"chipNoise": False}),
        )
        self.client.patch(
            "/api/session/tracks",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"sources": {"0": "game"}}),
        )

    def test_untouched_track_with_non_100_baseline_still_renders_as_default_group(self) -> None:
        # baseline(64%)が既定値100%でなくても、スライダーを未操作なら
        # 追加ゲイン無しの一括レンダリング（STEM_GAIN）になる — 実機音声には
        # 変換元の音量が既に含まれているため。
        self._convert_and_select_game()
        response = self.client.post("/api/render", headers=AUTH_HEADERS)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(self.libvgm_calls), 1)
        gains = [round(gain, 6) for _path, gain in self.mix_calls[0]]
        self.assertIn(round(mix.STEM_GAIN, 6), gains)

    def test_touched_track_scales_relative_to_baseline_not_100(self) -> None:
        # baseline 64% のトラックを128%へ設定 → ゲインはSTEM_GAIN*(128/64)=STEM_GAIN*2
        # であって、STEM_GAIN*(128/100)ではない。
        self._convert_and_select_game()
        self.client.patch(
            "/api/session/tracks",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"volumes": {"0": 128}}),
        )
        response = self.client.post("/api/render", headers=AUTH_HEADERS)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(self.libvgm_calls), 1)
        gains = [round(gain, 6) for _path, gain in self.mix_calls[0]]
        self.assertIn(round(mix.STEM_GAIN * 2, 6), gains)
        self.assertNotIn(round(mix.STEM_GAIN * 1.28, 6), gains)


class TestWebAppNsfChipTrackSource(unittest.TestCase):
    """NSF sidecarの自動サジェスト・音源PATCH・選択レンダリング（nsf2midi --chip-render）。

    TestWebAppLibvgmTrackSourceと対称のフィクスチャ形状を使う。実際のnsf2midiは
    NESに物理チャンネル共有が無いため常にsuggestedForHardwareMix=trueを書くが、
    ここではVGM同様に一部だけをsuggestedにしたsidecarでconvert_source()の
    プリセレクトロジック（if target.suggested）自体を検証する。
    """

    def setUp(self) -> None:
        self.nsf_chip_calls: list[tuple[Path, Path, int, list, int]] = []
        self.render_calls: list[tuple[Path, Path, Path | None]] = []
        self.render_note_counts: list[int] = []
        self.mix_calls: list[list[tuple[Path, float]]] = []

        def fake_converter(_fmt, _source, output_path, _options):
            output_path.write_bytes(build_fixture_bytes())
            nsf_chip.metadata_path_for(output_path).write_text(json.dumps({
                "version": 1,
                "sampleRate": 44100,
                "sampleCount": 44100,
                "tracks": [
                    {"trackIndex": 0, "channel": "SQ1", "chipRender": {
                        "channel": "SQ1", "groupId": "SQ1",
                        "suggestedForHardwareMix": False,
                    }},
                    {"trackIndex": 1, "channel": "NOISE", "chipRender": {
                        "channel": "NOISE", "groupId": "NOISE",
                        "suggestedForHardwareMix": True,
                    }},
                ],
            }), encoding="utf-8")
            return None, None

        def fake_nsf_chip(source, output, sample_count, targets, track):
            self.nsf_chip_calls.append((source, output, sample_count, targets, track))
            output.write_bytes(b"N" * 200)

        def fake_renderer(mid_path, wav_path, soundfont):
            self.render_calls.append((mid_path, wav_path, soundfont))
            dry_midi = mido.MidiFile(mid_path)
            self.render_note_counts.append(sum(
                msg.type == "note_on" and msg.velocity > 0
                for track in dry_midi.tracks for msg in track
            ))
            wav_path.write_bytes(b"D" * 200)

        def fake_mixer(inputs, output):
            self.mix_calls.append(inputs)
            output.write_bytes(b"M" * 200)

        # NSFはsupports_song_list=Trueなので、/api/source は曲一覧を取得しようと
        # する（VGMと違いこの注入が必須）。実バイナリを呼ばないよう十分な数の
        # ダミー曲を返す。
        def fake_list_songs(_fmt, _source_path):
            return {}, [
                {"index": i, "label": f"Track {i}", "durationSeconds": None, "detail": None}
                for i in range(4)
            ]

        self.app = create_app(
            token=TOKEN,
            session=WebSession(),
            converter=fake_converter,
            list_songs=fake_list_songs,
            renderer=fake_renderer,
            mixer=fake_mixer,
            nsf_chip_renderer=fake_nsf_chip,
        )
        self.client = self.app.test_client()
        self.addCleanup(self.app.config["MIDITRACK_SESSION"].clear)

    def _convert(self, chip_noise: bool, song_index: int = 3):
        self.client.post(
            "/api/source",
            headers=AUTH_HEADERS,
            data={"source": (io.BytesIO(b"fake-nsf"), "song.nsf")},
            content_type="multipart/form-data",
        )
        return self.client.post(
            "/api/source/convert",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"songIndex": song_index, "chipNoise": chip_noise}),
        )

    def test_checked_option_auto_selects_only_suggested_track(self) -> None:
        payload = self._convert(True).get_json()
        self.assertEqual(payload["tracks"][0]["source"], "soundfont")
        self.assertEqual(payload["tracks"][1]["source"], "game")
        self.assertTrue(payload["tracks"][1]["sourceSuggested"])
        self.assertEqual(payload["tracks"][1]["availableSources"], ["soundfont", "game"])

    def test_unchecked_option_leaves_tracks_on_soundfont(self) -> None:
        payload = self._convert(False).get_json()
        self.assertEqual(payload["tracks"][0]["source"], "soundfont")
        self.assertEqual(payload["tracks"][1]["source"], "soundfont")

    def test_selection_renders_nsf_chip_and_removes_midi_track_from_dry_mix(self) -> None:
        self._convert(True, song_index=3)
        response = self.client.post("/api/render", headers=AUTH_HEADERS)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(self.nsf_chip_calls), 1)
        source, _output, sample_count, targets, track = self.nsf_chip_calls[0]
        self.assertEqual(sample_count, 44100)
        # 変換時に指定した曲番号(-t/--track)をレンダリング時にも再指定する。
        self.assertEqual(track, 3)
        self.assertEqual({t.channel for t in targets}, {"NOISE"})
        self.assertEqual(len(self.render_calls), 1)
        self.assertEqual(self.render_note_counts, [1])
        self.assertEqual(len(self.mix_calls[0]), 2)

    def test_source_patch_switches_a_supported_track(self) -> None:
        self._convert(False)
        response = self.client.patch(
            "/api/session/tracks",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"sources": {"1": "game"}}),
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["tracks"][1]["source"], "game")

    def test_source_patch_allows_game_on_non_suggested_track(self) -> None:
        # suggestedForHardwareMix=falseでも、対応するtargetさえあれば明示的な
        # "game"指定は許可される（自動プリセレクトされないだけ）。
        self._convert(False)
        response = self.client.patch(
            "/api/session/tracks",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"sources": {"0": "game"}}),
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["tracks"][0]["source"], "game")

    def test_default_volume_game_tracks_render_nsf_chip_once(self) -> None:
        self._convert(False)
        self.client.patch(
            "/api/session/tracks",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"sources": {"0": "game", "1": "game"}}),
        )
        response = self.client.post("/api/render", headers=AUTH_HEADERS)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(self.nsf_chip_calls), 1)
        self.assertEqual({t.group_id for t in self.nsf_chip_calls[0][3]}, {"SQ1", "NOISE"})

    def test_custom_volume_game_track_is_rendered_individually(self) -> None:
        self._convert(False)
        self.client.patch(
            "/api/session/tracks",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({
                "sources": {"0": "game", "1": "game"},
                "volumes": {"1": 150},
            }),
        )
        response = self.client.post("/api/render", headers=AUTH_HEADERS)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(self.nsf_chip_calls), 2)
        default_call = next(c for c in self.nsf_chip_calls if len(c[3]) == 1 and c[3][0].group_id == "SQ1")
        custom_call = next(c for c in self.nsf_chip_calls if len(c[3]) == 1 and c[3][0].group_id == "NOISE")
        self.assertIsNotNone(default_call)
        self.assertIsNotNone(custom_call)
        gains = [round(gain, 6) for _path, gain in self.mix_calls[0]]
        self.assertIn(round(mix.STEM_GAIN * 1.5, 6), gains)
        self.assertIn(round(mix.STEM_GAIN, 6), gains)


class TestWebAppPreferences(unittest.TestCase):
    """楽器選択の「よく使う」設定（GET/PATCH /api/preferences）の挙動。

    ユーザーの実際の設定ファイル(~/Library/Application Support/miditrack/
    preferences.json)を汚染しないよう、MIDITRACK_PREFERENCES_PATHを
    一時ディレクトリへ差し替える。
    """

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self._env_backup = os.environ.get("MIDITRACK_PREFERENCES_PATH")
        os.environ["MIDITRACK_PREFERENCES_PATH"] = str(
            Path(self.tmp.name) / "preferences.json"
        )
        self.addCleanup(self._restore_env)
        self.app = create_app(token=TOKEN, session=WebSession())
        self.client = self.app.test_client()
        self.addCleanup(self.app.config["MIDITRACK_SESSION"].clear)

    def _restore_env(self) -> None:
        if self._env_backup is None:
            os.environ.pop("MIDITRACK_PREFERENCES_PATH", None)
        else:
            os.environ["MIDITRACK_PREFERENCES_PATH"] = self._env_backup

    def _upload(self):
        return self.client.post(
            "/api/session",
            headers=AUTH_HEADERS,
            data={"midi": (io.BytesIO(build_fixture_bytes()), "fixture.mid")},
            content_type="multipart/form-data",
        )

    def test_get_preferences_includes_default_ensemble_presets(self) -> None:
        response = self.client.get("/api/preferences", headers=AUTH_HEADERS)
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["pinnedPrograms"], [])
        self.assertEqual(payload["usageCounts"], {})
        self.assertIsNone(payload["selectedSoundfont"])
        self.assertEqual(payload["displayMode"], "normal")
        self.assertTrue(payload["roundedPianorollNotes"])
        self.assertTrue(payload["outlinedPianorollNotes"])
        self.assertTrue(payload["showPianorollKeyboard"])
        self.assertEqual(payload["appTheme"], "system")
        self.assertEqual(payload["pianorollHeight"], "standard")
        self.assertTrue(payload["showPianorollGrid"])
        self.assertEqual(payload["pianorollGridDivisions"], 8)
        self.assertIsNone(payload["pianorollBackgroundColor"])
        self.assertIsNone(payload["pianorollGridColor"])
        self.assertEqual(payload["trackColorPalette"], "rainbow")
        self.assertTrue(payload["hideEmptyTracks"])
        self.assertEqual(
            [preset["name"] for preset in payload["ensemblePresets"]],
            ["ゲームリード", "アコースティック", "ジャズカルテット"],
        )

    def test_patch_updates_pinned_programs(self) -> None:
        response = self.client.patch(
            "/api/preferences",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"pinnedPrograms": [80, 40]}),
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["pinnedPrograms"], [80, 40])

    def test_display_mode_persists_across_separate_apps(self) -> None:
        response = self.client.patch(
            "/api/preferences",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"displayMode": "fullscreen"}),
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["displayMode"], "fullscreen")
        other_app = create_app(token=TOKEN, session=WebSession())
        other_client = other_app.test_client()
        self.assertEqual(
            other_client.get("/api/preferences", headers=AUTH_HEADERS).get_json()["displayMode"],
            "fullscreen",
        )

    def test_patch_rejects_invalid_display_mode(self) -> None:
        response = self.client.patch(
            "/api/preferences",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"displayMode": "unsupported"}),
        )
        self.assertEqual(response.status_code, 400)

    def test_rounded_pianoroll_notes_preference_persists(self) -> None:
        response = self.client.patch(
            "/api/preferences",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"roundedPianorollNotes": False}),
        )
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.get_json()["roundedPianorollNotes"])
        other_app = create_app(token=TOKEN, session=WebSession())
        other_client = other_app.test_client()
        self.assertFalse(
            other_client.get("/api/preferences", headers=AUTH_HEADERS).get_json()["roundedPianorollNotes"]
        )

    def test_patch_rejects_invalid_rounded_pianoroll_notes_preference(self) -> None:
        response = self.client.patch(
            "/api/preferences",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"roundedPianorollNotes": "yes"}),
        )
        self.assertEqual(response.status_code, 400)

    def test_outlined_pianoroll_notes_preference_persists(self) -> None:
        response = self.client.patch(
            "/api/preferences",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"outlinedPianorollNotes": False}),
        )
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.get_json()["outlinedPianorollNotes"])
        other_app = create_app(token=TOKEN, session=WebSession())
        other_client = other_app.test_client()
        self.assertFalse(
            other_client.get("/api/preferences", headers=AUTH_HEADERS).get_json()["outlinedPianorollNotes"]
        )

    def test_patch_rejects_invalid_outlined_pianoroll_notes_preference(self) -> None:
        response = self.client.patch(
            "/api/preferences",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"outlinedPianorollNotes": "yes"}),
        )
        self.assertEqual(response.status_code, 400)

    def test_pianoroll_keyboard_preference_persists(self) -> None:
        response = self.client.patch(
            "/api/preferences",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"showPianorollKeyboard": False}),
        )
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.get_json()["showPianorollKeyboard"])
        other_app = create_app(token=TOKEN, session=WebSession())
        other_client = other_app.test_client()
        self.assertFalse(
            other_client.get("/api/preferences", headers=AUTH_HEADERS).get_json()["showPianorollKeyboard"]
        )

    def test_patch_rejects_invalid_pianoroll_keyboard_preference(self) -> None:
        response = self.client.patch(
            "/api/preferences",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"showPianorollKeyboard": "yes"}),
        )
        self.assertEqual(response.status_code, 400)

    def test_app_theme_preference_persists(self) -> None:
        response = self.client.patch(
            "/api/preferences",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"appTheme": "dark"}),
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["appTheme"], "dark")
        other_app = create_app(token=TOKEN, session=WebSession())
        other_client = other_app.test_client()
        self.assertEqual(
            other_client.get("/api/preferences", headers=AUTH_HEADERS).get_json()["appTheme"],
            "dark",
        )

    def test_patch_rejects_invalid_app_theme_preference(self) -> None:
        response = self.client.patch(
            "/api/preferences",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"appTheme": "solarized"}),
        )
        self.assertEqual(response.status_code, 400)

    def test_pianoroll_height_preference_persists(self) -> None:
        response = self.client.patch(
            "/api/preferences",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"pianorollHeight": "tall"}),
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["pianorollHeight"], "tall")
        other_app = create_app(token=TOKEN, session=WebSession())
        other_client = other_app.test_client()
        self.assertEqual(
            other_client.get("/api/preferences", headers=AUTH_HEADERS).get_json()["pianorollHeight"],
            "tall",
        )

    def test_patch_rejects_invalid_pianoroll_height_preference(self) -> None:
        response = self.client.patch(
            "/api/preferences",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"pianorollHeight": "huge"}),
        )
        self.assertEqual(response.status_code, 400)

    def test_pianoroll_grid_preferences_persist(self) -> None:
        response = self.client.patch(
            "/api/preferences",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"showPianorollGrid": False, "pianorollGridDivisions": 16}),
        )
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertFalse(payload["showPianorollGrid"])
        self.assertEqual(payload["pianorollGridDivisions"], 16)
        other_app = create_app(token=TOKEN, session=WebSession())
        other_client = other_app.test_client()
        other_payload = other_client.get("/api/preferences", headers=AUTH_HEADERS).get_json()
        self.assertFalse(other_payload["showPianorollGrid"])
        self.assertEqual(other_payload["pianorollGridDivisions"], 16)

    def test_patch_rejects_invalid_pianoroll_grid_divisions_preference(self) -> None:
        response = self.client.patch(
            "/api/preferences",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"pianorollGridDivisions": 10}),
        )
        self.assertEqual(response.status_code, 400)

    def test_pianoroll_color_preferences_persist_and_clear_to_none(self) -> None:
        response = self.client.patch(
            "/api/preferences",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({
                "pianorollBackgroundColor": "#1A2B3C",
                "pianorollGridColor": "#ABCDEF",
            }),
        )
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        # 保存時に小文字へ正規化される。
        self.assertEqual(payload["pianorollBackgroundColor"], "#1a2b3c")
        self.assertEqual(payload["pianorollGridColor"], "#abcdef")
        other_app = create_app(token=TOKEN, session=WebSession())
        other_client = other_app.test_client()
        other_payload = other_client.get("/api/preferences", headers=AUTH_HEADERS).get_json()
        self.assertEqual(other_payload["pianorollBackgroundColor"], "#1a2b3c")
        self.assertEqual(other_payload["pianorollGridColor"], "#abcdef")

        clear_response = self.client.patch(
            "/api/preferences",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"pianorollBackgroundColor": None}),
        )
        self.assertIsNone(clear_response.get_json()["pianorollBackgroundColor"])

    def test_patch_rejects_invalid_pianoroll_color_preference(self) -> None:
        response = self.client.patch(
            "/api/preferences",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"pianorollBackgroundColor": "red"}),
        )
        self.assertEqual(response.status_code, 400)

    def test_vivid_track_color_palette_preference_persists(self) -> None:
        response = self.client.patch(
            "/api/preferences",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"trackColorPalette": "vivid"}),
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["trackColorPalette"], "vivid")
        other_app = create_app(token=TOKEN, session=WebSession())
        other_client = other_app.test_client()
        self.assertEqual(
            other_client.get("/api/preferences", headers=AUTH_HEADERS).get_json()["trackColorPalette"],
            "vivid",
        )

    def test_patch_rejects_invalid_track_color_palette_preference(self) -> None:
        response = self.client.patch(
            "/api/preferences",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"trackColorPalette": "neon"}),
        )
        self.assertEqual(response.status_code, 400)

    def test_hide_empty_tracks_preference_persists(self) -> None:
        response = self.client.patch(
            "/api/preferences",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"hideEmptyTracks": False}),
        )
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.get_json()["hideEmptyTracks"])
        other_app = create_app(token=TOKEN, session=WebSession())
        other_client = other_app.test_client()
        self.assertFalse(
            other_client.get("/api/preferences", headers=AUTH_HEADERS).get_json()["hideEmptyTracks"]
        )

    def test_patch_rejects_invalid_hide_empty_tracks_preference(self) -> None:
        response = self.client.patch(
            "/api/preferences",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"hideEmptyTracks": "yes"}),
        )
        self.assertEqual(response.status_code, 400)

    def test_patch_persists_across_requests(self) -> None:
        self.client.patch(
            "/api/preferences",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"pinnedPrograms": [80], "usageCounts": {"80": 3}}),
        )
        response = self.client.get("/api/preferences", headers=AUTH_HEADERS)
        payload = response.get_json()
        self.assertEqual(payload["pinnedPrograms"], [80])
        self.assertEqual(payload["usageCounts"], {"80": 3})

    def test_patch_partial_update_preserves_other_field(self) -> None:
        self.client.patch(
            "/api/preferences",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"pinnedPrograms": [80], "usageCounts": {"80": 1}}),
        )
        response = self.client.patch(
            "/api/preferences",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"usageCounts": {"80": 2}}),
        )
        payload = response.get_json()
        self.assertEqual(payload["pinnedPrograms"], [80])
        self.assertEqual(payload["usageCounts"], {"80": 2})

    def test_patch_saves_custom_ensemble_preset(self) -> None:
        custom_preset = {
            "id": "custom-synthwave",
            "name": "Synthwave",
            "programs": {
                "melody": 80,
                "counterMelody": 81,
                "bass": 38,
                "accompaniment": 88,
                "percussion": 24,
            },
        }
        response = self.client.patch(
            "/api/preferences",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"ensemblePresets": [custom_preset]}),
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["ensemblePresets"], [custom_preset])
        loaded = self.client.get("/api/preferences", headers=AUTH_HEADERS).get_json()
        self.assertEqual(loaded["ensemblePresets"], [custom_preset])

    def test_patch_rejects_invalid_ensemble_preset_role(self) -> None:
        response = self.client.patch(
            "/api/preferences",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({
                "ensemblePresets": [{
                    "id": "custom-invalid",
                    "name": "Invalid",
                    "programs": {"melody": 80},
                }],
            }),
        )
        self.assertEqual(response.status_code, 400)

    def test_patch_requires_at_least_one_field(self) -> None:
        response = self.client.patch(
            "/api/preferences",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({}),
        )
        self.assertEqual(response.status_code, 400)

    def test_patch_rejects_invalid_program(self) -> None:
        response = self.client.patch(
            "/api/preferences",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"pinnedPrograms": [128]}),
        )
        self.assertEqual(response.status_code, 400)

    def test_preferences_survive_across_separate_apps(self) -> None:
        # 別ポート（≒別create_app()インスタンス）でも同じファイルを読み書きする
        # ことの回帰ガード ― ブラウザのlocalStorageと違い、プロセスの
        # 起動ごとに変わるポートに依存しないことがこの機能の目的そのもの。
        self.client.patch(
            "/api/preferences",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"pinnedPrograms": [81]}),
        )
        other_app = create_app(token=TOKEN, session=WebSession())
        other_client = other_app.test_client()
        response = other_client.get("/api/preferences", headers=AUTH_HEADERS)
        self.assertEqual(response.get_json()["pinnedPrograms"], [81])

    def _make_soundfont_file(self) -> Path:
        path = Path(self.tmp.name) / "dummy.sf2"
        path.write_bytes(b"0" * 16)
        return path

    def test_setting_soundfont_persists_selected_soundfont(self) -> None:
        soundfont_path = self._make_soundfont_file()
        response = self.client.post(
            "/api/soundfont",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"path": str(soundfont_path)}),
        )
        self.assertEqual(response.status_code, 200)
        preferences_response = self.client.get("/api/preferences", headers=AUTH_HEADERS)
        self.assertEqual(
            preferences_response.get_json()["selectedSoundfont"], str(soundfont_path)
        )

    def test_clearing_soundfont_clears_selected_soundfont(self) -> None:
        soundfont_path = self._make_soundfont_file()
        self.client.post(
            "/api/soundfont",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"path": str(soundfont_path)}),
        )
        self.client.post(
            "/api/soundfont",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"path": None}),
        )
        preferences_response = self.client.get("/api/preferences", headers=AUTH_HEADERS)
        self.assertIsNone(preferences_response.get_json()["selectedSoundfont"])

    def test_selected_soundfont_survives_across_separate_apps(self) -> None:
        soundfont_path = self._make_soundfont_file()
        self.client.post(
            "/api/soundfont",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"path": str(soundfont_path)}),
        )
        other_app = create_app(token=TOKEN, session=WebSession())
        other_client = other_app.test_client()
        response = other_client.get("/api/preferences", headers=AUTH_HEADERS)
        self.assertEqual(response.get_json()["selectedSoundfont"], str(soundfont_path))

    # --- プロジェクト保存・復元 ---

    def test_project_round_trip_restores_editing_state(self) -> None:
        self._upload()
        self.client.patch(
            "/api/session/tracks",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"assignments": {"0": 30}, "volumes": {"0": 140}}),
        )
        self.client.patch(
            "/api/session/transform",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"speed": 1.2, "transpose": 3}),
        )
        self.client.patch(
            "/api/session/filename",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"name": "saved project"}),
        )

        acoustic_preset = next(
            preset for preset in preferences.build_default_ensemble_presets()
            if preset["id"] == "acoustic"
        )
        exported = self.client.post(
            "/api/project/export",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({
                "renderMode": "quality",
                "loop": {"start": 1.0, "end": 2.5, "enabled": True},
                "ensemblePreset": "acoustic",
                "ensemblePresetDefinition": acoustic_preset,
                "trackRoles": {"0": "melody", "1": "percussion"},
                "ensemblePresetSnapshot": {
                    "assignments": {"0": 12, "1": None},
                    "sources": {"0": "soundfont", "1": "soundfont"},
                },
            }),
        )
        self.assertEqual(exported.status_code, 200)
        self.assertEqual(exported.mimetype, "application/vnd.miditrack.project+zip")
        with zipfile.ZipFile(io.BytesIO(exported.data)) as archive:
            self.assertEqual(set(archive.namelist()), {"manifest.json", "midi/original.mid"})
            manifest = json.loads(archive.read("manifest.json"))
        self.assertEqual(manifest["format"], "miditrack-project")
        self.assertEqual(manifest["edits"]["assignments"], {"0": 30})
        self.assertEqual(manifest["ui"]["renderMode"], "quality")
        self.assertEqual(
            manifest["ui"]["loop"],
            {"start": 1.0, "end": 2.5, "enabled": True},
        )
        self.assertEqual(manifest["ui"]["ensemblePreset"], "acoustic")
        self.assertEqual(manifest["ui"]["ensemblePresetDefinition"], acoustic_preset)
        self.assertEqual(
            manifest["ui"]["trackRoles"],
            {"0": "melody", "1": "percussion"},
        )
        self.assertEqual(
            manifest["ui"]["ensemblePresetSnapshot"],
            {
                "assignments": {"0": 12, "1": None},
                "sources": {"0": "soundfont", "1": "soundfont"},
            },
        )

        self.client.delete("/api/session", headers=AUTH_HEADERS)
        imported = self.client.post(
            "/api/project/import",
            headers=AUTH_HEADERS,
            data={"project": (io.BytesIO(exported.data), "saved.miditrack")},
            content_type="multipart/form-data",
        )
        self.assertEqual(imported.status_code, 200)
        payload = imported.get_json()
        self.assertEqual(
            payload["uiState"],
            {
                "renderMode": "quality",
                "loop": {"start": 1.0, "end": 2.5, "enabled": True},
                "ensemblePreset": "acoustic",
                "ensemblePresetDefinition": acoustic_preset,
                "trackRoles": {"0": "melody", "1": "percussion"},
                "ensemblePresetSnapshot": {
                    "assignments": {"0": 12, "1": None},
                    "sources": {"0": "soundfont", "1": "soundfont"},
                },
            },
        )
        self.assertEqual(payload["warnings"], [])
        session = payload["session"]
        self.assertEqual(session["downloadStem"], "saved project")
        self.assertEqual(session["tracks"][0]["assignedProgram"], 30)
        self.assertEqual(session["tracks"][0]["volumePercent"], 140)
        self.assertEqual(session["speed"], 1.2)
        self.assertEqual(session["transpose"], 3)

    def test_invalid_project_keeps_current_session(self) -> None:
        self._upload()
        response = self.client.post(
            "/api/project/import",
            headers=AUTH_HEADERS,
            data={"project": (io.BytesIO(b"not a zip"), "broken.miditrack")},
            content_type="multipart/form-data",
        )
        self.assertEqual(response.status_code, 400)
        current = self.client.get("/api/session", headers=AUTH_HEADERS).get_json()
        self.assertEqual(current["filename"], "fixture")
        self.assertEqual(len(current["tracks"]), 2)

    def test_project_export_rejects_invalid_loop_track_role_and_snapshot(self) -> None:
        self._upload()
        invalid_loop = self.client.post(
            "/api/project/export",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({
                "renderMode": "fast",
                "loop": {"start": 2.0, "end": 1.0, "enabled": True},
            }),
        )
        self.assertEqual(invalid_loop.status_code, 400)
        invalid_role = self.client.post(
            "/api/project/export",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({
                "renderMode": "fast",
                "ensemblePreset": "acoustic",
                "trackRoles": {"0": "unknown"},
            }),
        )
        self.assertEqual(invalid_role.status_code, 400)
        invalid_snapshot = self.client.post(
            "/api/project/export",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({
                "renderMode": "fast",
                "ensemblePreset": "acoustic",
                "trackRoles": {"0": "melody"},
                "ensemblePresetSnapshot": {
                    "assignments": {"0": 12},
                    "sources": {"0": "soundfont"},
                },
            }),
        )
        self.assertEqual(invalid_snapshot.status_code, 400)

    def test_project_controls_and_deferred_patches_are_wired(self) -> None:
        html = self.client.get("/").get_data(as_text=True)
        css = self.client.get("/assets/app.css").get_data(as_text=True)
        javascript = self.client.get("/assets/app.js").get_data(as_text=True)
        self.assertIn('id="open-project-button"', html)
        self.assertIn('id="save-project-button"', html)
        self.assertIn('id="project-input"', html)
        self.assertIn("function handleSaveProject()", javascript)
        self.assertIn("function handleOpenProject(file)", javascript)
        self.assertIn("await flushPendingDownloadFilename();", javascript)
        self.assertIn('apiFetch("/api/project/import"', javascript)
        self.assertIn('id="pianoroll-loop-region"', html)
        self.assertIn('id="ensemble-preset-select"', html)
        self.assertIn('id="ensemble-preset-new"', html)
        self.assertIn('id="ensemble-preset-dialog"', html)
        self.assertIn("function suggestTrackRoles()", javascript)
        self.assertIn("function handleEnsemblePresetSave", javascript)
        self.assertIn("function setupTrackHighlightControl", javascript)
        self.assertIn("function setFullscreenLayout", javascript)
        self.assertIn("function saveDisplayMode", javascript)
        self.assertIn('id="pianoroll-rounded-notes"', html)
        self.assertIn('id="pianoroll-outlined-notes"', html)
        self.assertIn('id="pianoroll-keyboard"', html)
        self.assertIn('class="pianoroll-keyboard"', html)
        self.assertIn('id="pianoroll-show-keyboard"', html)
        self.assertIn("function drawPianorollNote", javascript)
        self.assertIn("context.roundRect", javascript)
        self.assertIn("function getTrackOutlineColor", javascript)
        self.assertIn("context.strokeRect", javascript)
        self.assertIn("function saveRoundedPianorollNotes", javascript)
        self.assertIn("function saveOutlinedPianorollNotes", javascript)
        self.assertIn("function drawPianorollKeyboard", javascript)
        self.assertIn("function isPianorollBlackKey", javascript)
        self.assertIn("function pianorollPitchCenterY", javascript)
        self.assertIn("function pianorollPitchBounds", javascript)
        self.assertIn("const top = Math.round(pianorollPitchY(pitch, layout))", javascript)
        self.assertIn("function pianorollWhiteKeyBounds", javascript)
        self.assertIn("adjacentPianorollWhitePitch", javascript)
        self.assertIn("pianorollPitchCenterY(pitch, layout)", javascript)
        self.assertIn("const blackKeyWidth = Math.round(size.width * 0.72)", javascript)
        self.assertIn("const { top, height } = pianorollPitchBounds(pitch, layout)", javascript)
        self.assertIn("context.fillRect(0, top, blackKeyWidth, height)", javascript)
        self.assertIn("const pitchBounds = pianorollPitchBounds(note, layout)", javascript)
        self.assertIn("function pianorollOctaveLabel", javascript)
        self.assertIn("Math.floor(pitch / 12) - 1", javascript)
        self.assertIn("function savePianorollKeyboardVisibility", javascript)
        self.assertIn("keyboardResizeObserver.observe", javascript)
        self.assertIn("showPianorollKeyboard", javascript)
        self.assertIn('cssColor("--pianoroll-key-white"', javascript)
        self.assertIn('cssColor("--pianoroll-key-black"', javascript)
        keyboard_rule = css.split(".pianoroll-keyboard {", 1)[1].split("}", 1)[0]
        self.assertIn("min-width: 48px", keyboard_rule)
        self.assertIn("max-width: 48px", keyboard_rule)
        self.assertIn("border-right: 1px solid var(--pianoroll-keyboard-divider)", keyboard_rule)
        self.assertIn("--pianoroll-key-white", css)
        self.assertIn("--pianoroll-key-black", css)
        self.assertIn("--pianoroll-frame-border: #aeb9c9", css)
        self.assertIn("--pianoroll-keyboard-divider: #7b899e", css)
        self.assertIn("--pianoroll-key-label: #334155", css)
        # 表示設定ダイアログ: 歯車ボタンとダイアログ本体がメインUIから
        # 分離され、旧チェックボックス群が.pianoroll-footer/トラック一覧
        # から消えている（ダイアログ内へ移設された）ことを確認する。
        self.assertIn('id="settings-open"', html)
        self.assertIn('class="header-actions" aria-label="表示操作"', html)
        header_actions = html.split('class="header-actions"', 1)[1].split("</div>", 1)[0]
        self.assertLess(
            header_actions.index('id="open-dialog-button"'),
            header_actions.index('id="fullscreen-toggle"'),
        )
        self.assertLess(
            header_actions.index('id="fullscreen-toggle"'),
            header_actions.index('id="settings-open"'),
        )
        self.assertIn('header-action-button', header_actions)
        self.assertIn('id="settings-dialog"', html)
        self.assertIn('id="app-theme"', html)
        self.assertIn('id="pianoroll-height"', html)
        self.assertIn('id="pianoroll-background-color"', html)
        self.assertIn('id="pianoroll-background-reset"', html)
        self.assertIn('id="pianoroll-show-grid"', html)
        self.assertIn('id="pianoroll-grid-color"', html)
        self.assertIn('id="pianoroll-grid-reset"', html)
        self.assertIn('id="pianoroll-grid-divisions"', html)
        self.assertIn('id="track-color-palette"', html)
        self.assertIn('<option value="vivid">彩度強め</option>', html)
        self.assertIn('id="output-card"', html)
        output_heading = html.split('class="card-heading output-card-heading"', 1)[1].split("</div>", 2)[0]
        self.assertIn('<span class="step-number">4</span>', output_heading)
        self.assertIn('id="output-card-title">出力</h2>', output_heading)
        self.assertLess(html.index('id="audition-card"'), html.index('id="output-card"'))
        self.assertNotIn("MIDIはこのMacの中だけで処理されます。", html)
        self.assertIn('body.is-fullscreen #output-card { display: contents; }', css)
        self.assertIn(
            'body.is-fullscreen .app-shell > #output-card > .download-toolbar { grid-column: 2; grid-row: 4;',
            css,
        )
        self.assertIn('$("#output-card").classList.toggle("ready", ready);', javascript)
        self.assertIn('id="hide-empty-tracks"', html)
        self.assertIn('class="settings-checkbox-row"', html)
        checkbox_row_start = html.index('class="settings-checkbox-row"')
        keyboard_checkbox_start = html.index('id="pianoroll-show-keyboard"')
        self.assertLess(checkbox_row_start, html.index('id="pianoroll-rounded-notes"'))
        self.assertLess(html.index('id="pianoroll-outlined-notes"'), keyboard_checkbox_start)
        self.assertLess(html.index('id="pianoroll-show-grid"'), keyboard_checkbox_start)
        self.assertIn('class="settings-field-row settings-color-fields"', html)
        self.assertEqual(html.count('class="settings-field-row"'), 1)
        self.assertIn('.settings-field-row {', css)
        self.assertIn('grid-template-columns: repeat(2, minmax(0, 1fr))', css)
        self.assertIn('.settings-field-row .field-group {\n  min-width: 0;\n  margin-top: 0;', css)
        self.assertIn('.app-header .header-action-button {', css)
        self.assertIn('color: #fff', css)
        footer_block = html.split('class="pianoroll-footer"', 1)[1].split("</div>", 1)[0]
        self.assertNotIn("checkbox", footer_block)
        self.assertIn("function setupSettingsDialog", javascript)
        self.assertIn("function resolveTheme", javascript)
        self.assertIn("function applyThemeSetting", javascript)
        self.assertIn("function applyPianorollColors", javascript)
        self.assertIn("function savePreferenceFields", javascript)
        self.assertIn("TRACK_COLOR_PALETTES", javascript)
        self.assertIn("vivid:", javascript)
        self.assertIn("hsl(${hue} 90% 48% / ${opacity})", javascript)
        self.assertIn("#upload-card { box-shadow: 0 1px 2px", css)
        self.assertIn('data-theme="dark"', css)
        self.assertNotIn("@media (prefers-color-scheme: dark)", css)
        self.assertIn('displayMode: state.displayMode', javascript)
        fullscreen_setup_block = javascript.split("function setupFullscreenLayout() {", 1)[1].split(
            "\n}\n\n// 通常表示用のアップロードカード", 1
        )[0]
        self.assertIn('if (event.key !== "Escape") return;', fullscreen_setup_block)
        self.assertIn('if (document.querySelector("dialog[open]")) return;', fullscreen_setup_block)
        self.assertIn(
            'setFullscreenLayout(!document.body.classList.contains("is-fullscreen"), { shouldPersist: true });',
            fullscreen_setup_block,
        )
        self.assertNotIn(
            'if (!document.body.classList.contains("is-fullscreen")) return;',
            fullscreen_setup_block,
        )


class TestResolveStartupSoundfontOverride(unittest.TestCase):
    """web.resolve_startup_soundfont_override() — run_server()の起動時復元ロジック。"""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self._env_backup = os.environ.get("MIDITRACK_PREFERENCES_PATH")
        os.environ["MIDITRACK_PREFERENCES_PATH"] = str(
            Path(self.tmp.name) / "preferences.json"
        )
        self.addCleanup(self._restore_env)

    def _restore_env(self) -> None:
        if self._env_backup is None:
            os.environ.pop("MIDITRACK_PREFERENCES_PATH", None)
        else:
            os.environ["MIDITRACK_PREFERENCES_PATH"] = self._env_backup

    def _make_soundfont_file(self, name: str = "dummy.sf2") -> Path:
        path = Path(self.tmp.name) / name
        path.write_bytes(b"0" * 16)
        return path

    def test_explicit_soundfont_always_wins_returns_none(self) -> None:
        saved = self._make_soundfont_file()
        preferences.save_preferences({"selectedSoundfont": str(saved)})
        explicit = self._make_soundfont_file("explicit.sf2")
        self.assertIsNone(resolve_startup_soundfont_override(explicit))

    def test_no_explicit_soundfont_restores_saved_one(self) -> None:
        saved = self._make_soundfont_file()
        preferences.save_preferences({"selectedSoundfont": str(saved)})
        self.assertEqual(resolve_startup_soundfont_override(None), saved)

    def test_no_saved_soundfont_returns_none(self) -> None:
        self.assertIsNone(resolve_startup_soundfont_override(None))

    def test_saved_soundfont_no_longer_existing_returns_none(self) -> None:
        preferences.save_preferences(
            {"selectedSoundfont": str(Path(self.tmp.name) / "deleted.sf2")}
        )
        self.assertIsNone(resolve_startup_soundfont_override(None))


class TestTrackFilenameLabel(unittest.TestCase):
    """_track_filename_label(): 「トラックごとに出力」のファイル名断片への正規化。"""

    def test_dot_in_track_name_is_not_truncated(self) -> None:
        # sanitize_stem()はPath(...).stemを通すため"St.Trumpet"は"St"に切り詰め
        # られるが、_track_filename_label()はトラック名専用なのでそれをしない。
        self.assertEqual(_track_filename_label("St.Trumpet", 0), "St.Trumpet")

    def test_unsafe_characters_are_replaced(self) -> None:
        self.assertEqual(_track_filename_label("Lead/Synth: 1", 0), "Lead_Synth_ 1")

    def test_empty_name_falls_back_to_track_index(self) -> None:
        self.assertEqual(_track_filename_label("", 3), "Track3")

    def test_whitespace_only_name_falls_back_to_track_index(self) -> None:
        self.assertEqual(_track_filename_label("   ", 5), "Track5")

    def test_leading_and_trailing_space_and_dot_are_stripped(self) -> None:
        self.assertEqual(_track_filename_label(" Bass. ", 0), "Bass")


if __name__ == "__main__":
    unittest.main()

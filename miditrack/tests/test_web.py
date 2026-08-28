"""miditrack.web のテスト。

renderer を注入することで実際の fluidsynth/midi2wav.sh は起動しない。
"""

from __future__ import annotations

import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

import mido

from miditrack import libvgm, nsf_chip
from miditrack.convert import SourceFormat
from miditrack.errors import ConvertError
from miditrack.web import WebSession, create_app


def build_zip_bytes(members: dict[str, bytes]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as zf:
        for name, data in members.items():
            zf.writestr(name, data)
    return buffer.getvalue()

TOKEN = "test-token"
AUTH_HEADERS = {"X-Miditrack-Token": TOKEN}


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

    def test_download_wav_reuses_existing_render(self) -> None:
        self._upload()
        self.client.post("/api/render", headers=AUTH_HEADERS)
        self.assertEqual(len(self.render_calls), 1)
        response = self.client.get("/api/download/wav", headers=AUTH_HEADERS)
        self.assertEqual(response.status_code, 200)
        # 既にレンダリング済みなら再レンダリングしない。
        self.assertEqual(len(self.render_calls), 1)

    def test_download_wav_without_upload_is_rejected(self) -> None:
        response = self.client.get("/api/download/wav", headers=AUTH_HEADERS)
        self.assertEqual(response.status_code, 400)

    # --- 速度・ピッチのバリエーション ---

    def test_pitch_shift_renders_first_when_not_yet_rendered(self) -> None:
        self._upload()
        response = self.client.post("/api/pitch-shift", headers=AUTH_HEADERS)
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(len(self.render_calls), 1)
        self.assertEqual(len(self.pitch_shift_calls), 1)
        # 既定値（速度2種 x ピッチ5種）= 10件。
        self.assertEqual(len(payload["items"]), 10)
        self.assertEqual(payload["downloadUrl"], "/api/download/pitch-shift")

    def test_pitch_shift_uses_custom_speeds_and_pitches(self) -> None:
        self._upload()
        self.client.post("/api/render", headers=AUTH_HEADERS)
        response = self.client.post(
            "/api/pitch-shift",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"speeds": [1.5], "pitches": [-1, 1]}),
        )
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(len(payload["items"]), 2)
        _, _, speeds, pitches = self.pitch_shift_calls[-1]
        self.assertEqual(speeds, [1.5])
        self.assertEqual(pitches, [-1, 1])

    def test_pitch_shift_rejects_too_many_combinations(self) -> None:
        self._upload()
        speeds = [1.0] * 8
        pitches = [0] * 12
        response = self.client.post(
            "/api/pitch-shift",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"speeds": speeds, "pitches": pitches}),
        )
        self.assertEqual(response.status_code, 502)
        self.assertEqual(len(self.pitch_shift_calls), 0)

    def test_pitch_shift_without_upload_is_rejected(self) -> None:
        response = self.client.post("/api/pitch-shift", headers=AUTH_HEADERS)
        self.assertEqual(response.status_code, 400)

    def test_download_pitch_shift_requires_prior_generation(self) -> None:
        self._upload()
        response = self.client.get("/api/download/pitch-shift", headers=AUTH_HEADERS)
        self.assertEqual(response.status_code, 400)

    def test_download_pitch_shift_returns_zip_with_all_variants(self) -> None:
        self._upload()
        self.client.post("/api/pitch-shift", headers=AUTH_HEADERS)
        response = self.client.get("/api/download/pitch-shift", headers=AUTH_HEADERS)
        self.assertEqual(response.status_code, 200)
        self.assertIn("attachment", response.headers.get("Content-Disposition", ""))
        self.assertIn(".zip", response.headers.get("Content-Disposition", ""))
        archive = zipfile.ZipFile(io.BytesIO(response.data))
        self.assertEqual(len(archive.namelist()), 10)

    def test_pitch_shift_invalidated_by_new_render(self) -> None:
        self._upload()
        self.client.post("/api/pitch-shift", headers=AUTH_HEADERS)
        self.client.get("/api/download/pitch-shift", headers=AUTH_HEADERS)
        # 再レンダリングすると古いピッチシフトZIPは無効化される。
        self.client.post("/api/render", headers=AUTH_HEADERS)
        response = self.client.get("/api/download/pitch-shift", headers=AUTH_HEADERS)
        self.assertEqual(response.status_code, 400)

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

    def test_download_wav_and_pitch_shift_receive_mixed_audio(self) -> None:
        self._upload_source_with_chip_noise()

        response = self.client.get("/api/download/wav", headers=AUTH_HEADERS)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data, b"M" * 300)

        session = self.app.config["MIDITRACK_SESSION"]
        pitch_shifter_calls: list[Path] = []

        def fake_pitch_shifter(wav_path, work_dir, speeds, pitches):
            pitch_shifter_calls.append(wav_path)
            out = work_dir / "variant.wav"
            out.write_bytes(b"0" * 100)
            return [out]

        # pitch-shiftはensure_render()経由でaudio_path（合成後）を受け取ることを
        # 確認する: 別appを新規に立てず、同じセッションに対して直接呼び出す。
        # pitch_shift_endpoint()はaudio_pathをwork_dir内へコピーしてから渡すため
        # （web.py参照）、パスそのものではなくコピーされた内容で検証する。
        app2 = create_app(
            token=TOKEN,
            session=session,
            renderer=self.fake_renderer,
            list_songs=self.fake_list_songs,
            converter=self.fake_converter_with_stem,
            mixer=self.fake_mixer,
            pitch_shifter=fake_pitch_shifter,
        )
        client2 = app2.test_client()
        response = client2.post("/api/pitch-shift", headers=AUTH_HEADERS)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(pitch_shifter_calls), 1)
        self.assertEqual(pitch_shifter_calls[0].read_bytes(), b"M" * 300)

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

        def fake_converter_with_sf2(
            fmt: SourceFormat, source_path: Path, output_path: Path, options: dict
        ) -> tuple[Path | None, Path | None]:
            self.convert_calls.append((fmt, source_path, output_path, options))
            output_path.write_bytes(build_fixture_bytes())
            if options.get("gameSoundfont"):
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
            [["game", "soundfont"], ["game", "soundfont"]],
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

    def test_conversion_without_option_leaves_has_game_soundfont_false(self) -> None:
        data = {"source": (io.BytesIO(b"fake source bytes"), "song.spc")}
        self.client.post(
            "/api/source", headers=AUTH_HEADERS, data=data, content_type="multipart/form-data"
        )
        response = self.client.post(
            "/api/source/convert",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"songIndex": 0, "gameSoundfont": False}),
        )
        self.assertFalse(response.get_json()["hasGameSoundfont"])

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


class TestWebAppLibvgmTrackSource(unittest.TestCase):
    """VGM sidecarの自動サジェスト・音源PATCH・選択レンダリング。"""

    def setUp(self) -> None:
        self.libvgm_calls: list[tuple[Path, Path, int, list]] = []
        self.render_calls: list[tuple[Path, Path, Path | None]] = []
        self.render_note_counts: list[int] = []
        self.mix_calls: list[list[tuple[Path, float]]] = []

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
            self.libvgm_calls.append((source, output, sample_count, targets))
            output.write_bytes(b"L" * 200)

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

    def test_source_patch_switches_a_supported_track(self) -> None:
        self._convert(False)
        response = self.client.patch(
            "/api/session/tracks",
            headers={**AUTH_HEADERS, "Content-Type": "application/json"},
            data=json.dumps({"sources": {"0": "game"}}),
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["tracks"][0]["source"], "game")


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


if __name__ == "__main__":
    unittest.main()

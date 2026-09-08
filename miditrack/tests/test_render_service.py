"""RenderServiceのLRUと音源世代管理の単体テスト。"""

from __future__ import annotations

import tempfile
import threading
import unittest
from collections import OrderedDict
from pathlib import Path
from types import SimpleNamespace

from miditrack import midi
from miditrack.render_service import (
    CachedRenderRequest,
    PreviewRenderRequest,
    RenderService,
)


class TestRenderService(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.session = SimpleNamespace(
            root=Path(self.temp.name),
            state_lock=threading.RLock(),
            render_cache=OrderedDict(),
            render_cache_bytes=0,
            preview_cache=OrderedDict(),
            preview_cache_bytes=0,
            audio_path=None,
            audio_sources=OrderedDict(),
            render_id=0,
            current_render_key=None,
            current_render_mode=None,
            current_render_id=0,
            original_path=Path(self.temp.name) / "original.mid",
            applied_path=None,
            apply_summary=None,
            applied_duration_seconds=None,
            state_revision=0,
            speed_ratio=1.0,
            transpose_semitones=0,
        )
        self.service = RenderService(
            self.session,
            render_cache_max_entries=1,
            render_cache_max_bytes=1024,
            preview_cache_max_entries=1,
            preview_cache_max_bytes=1024,
            audio_source_history_limit=3,
        )

    def _write_wav(self, name: str) -> Path:
        path = self.session.root / name
        path.write_bytes(b"R" * 45)
        return path

    def test_cache_keeps_crossfade_source_until_history_is_released(self) -> None:
        old_path = self._write_wav("old.wav")
        new_path = self._write_wav("new.wav")
        final_path = self._write_wav("final.wav")
        self.service.cache_store("old", old_path)
        self.service.register_audio_source(1, old_path)
        self.service.cache_store("new", new_path)

        self.assertEqual(self.service.cache_lookup("old"), old_path)
        self.assertEqual(self.service.cache_lookup("new"), new_path)
        self.assertTrue(old_path.exists())

        self.session.audio_sources.clear()
        self.service.cache_store("final", final_path)
        self.assertIsNone(self.service.cache_lookup("old"))
        self.assertTrue(final_path.exists())

    def test_preview_cache_and_render_ids_are_independent(self) -> None:
        first_path = self._write_wav("first.wav")
        second_path = self._write_wav("second.wav")
        window = midi.MidiWindow(1.0, 2.0)
        self.service.preview_cache_store("first", first_path, window)
        self.service.preview_cache_store("second", second_path, window)

        self.assertIsNone(self.service.preview_cache_lookup("first"))
        self.assertEqual(self.service.preview_cache_lookup("second").path, second_path)
        self.assertEqual(self.service.next_render_id(), 1)
        self.assertEqual(self.service.next_render_id(), 2)

    def test_apply_is_cached_after_a_stable_state_update(self) -> None:
        apply_count = 0

        def apply_to(path: Path, speed: float, transpose: int) -> dict[str, int | float]:
            nonlocal apply_count
            apply_count += 1
            self.assertEqual((speed, transpose), (1.0, 0))
            path.write_bytes(b"MIDI")
            return {"durationSeconds": 12.5}

        path, summary, elapsed_ms = self.service.ensure_applied(
            apply_to,
            lambda: AssertionError("missing source"),
            lambda: AssertionError("unstable state"),
        )
        cached_path, cached_summary, cached_elapsed_ms = self.service.ensure_applied(
            apply_to,
            lambda: AssertionError("missing source"),
            lambda: AssertionError("unstable state"),
        )

        self.assertEqual(apply_count, 1)
        self.assertEqual(path, cached_path)
        self.assertEqual(summary, cached_summary)
        self.assertGreaterEqual(elapsed_ms, 0)
        self.assertEqual(cached_elapsed_ms, 0)

    def test_cached_render_retries_stale_output_and_reuses_stable_result(self) -> None:
        render_count = 0

        def build_request() -> CachedRenderRequest:
            def render_to(path: Path, _work_id: int) -> None:
                nonlocal render_count
                render_count += 1
                path.write_bytes(b"R" * 45)
                if render_count == 1:
                    self.session.state_revision += 1

            return CachedRenderRequest("render:state", "fast", "state", render_to)

        result = self.service.ensure_cached_render(
            build_request, lambda: AssertionError("unstable state")
        )
        cached_result = self.service.ensure_cached_render(
            build_request, lambda: AssertionError("unstable state")
        )

        self.assertEqual(render_count, 2)
        self.assertFalse(result.cache_hit)
        self.assertEqual(result.work_id, 2)
        self.assertTrue((self.session.root / "render-cache" / "fast-state.wav").exists())
        self.assertTrue(cached_result.cache_hit)
        self.assertIsNone(cached_result.work_id)

    def test_cached_preview_retries_stale_output_and_reuses_stable_result(self) -> None:
        render_count = 0

        def output_path_for(work_id: int) -> Path:
            return self.session.root / f"preview-{work_id}.wav"

        def render_to(path: Path, _work_id: int) -> midi.MidiWindow:
            nonlocal render_count
            render_count += 1
            path.write_bytes(b"R" * 45)
            if render_count == 1:
                self.session.state_revision += 1
            return midi.MidiWindow(1.0, 2.0)

        request = PreviewRenderRequest("preview:state", output_path_for, render_to)
        result = self.service.ensure_cached_preview(
            request, lambda: AssertionError("unstable state")
        )
        cached_result = self.service.ensure_cached_preview(
            request, lambda: AssertionError("unstable state")
        )

        self.assertEqual(render_count, 2)
        self.assertFalse(result.cache_hit)
        self.assertEqual(result.entry.path, output_path_for(2))
        self.assertFalse(output_path_for(1).exists())
        self.assertTrue(cached_result.cache_hit)
        self.assertEqual(cached_result.entry.window, midi.MidiWindow(1.0, 2.0))

    def test_activate_full_render_reuses_or_allocates_the_expected_generation(self) -> None:
        first_path = self._write_wav("first.wav")
        preview_path = self._write_wav("preview.wav")
        second_path = self._write_wav("second.wav")
        first_work_id = self.service.next_render_id()

        first_id = self.service.activate_full_render(
            "render:first", first_path, "fast", first_work_id, False
        )
        preview_id = self.service.next_render_id()
        self.service.register_audio_source(preview_id, preview_path)
        repeated_id = self.service.activate_full_render(
            "render:first", first_path, "fast", None, True
        )
        second_id = self.service.activate_full_render(
            "render:second", second_path, "quality", None, True
        )

        self.assertEqual((first_id, repeated_id, second_id), (1, 1, 3))
        self.assertEqual(self.session.audio_path, second_path)
        self.assertEqual(self.session.current_render_mode, "quality")
        self.assertEqual(self.session.audio_sources[1], first_path)
        self.assertEqual(self.session.audio_sources[2], preview_path)
        self.assertEqual(self.session.audio_sources[3], second_path)


if __name__ == "__main__":
    unittest.main()

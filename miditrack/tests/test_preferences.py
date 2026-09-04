"""miditrack.preferences のテスト。

実際のユーザーホームを汚染しないよう、MIDITRACK_PREFERENCES_PATHで
一時ディレクトリ内のパスに差し替える。
"""

from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from miditrack import preferences
from miditrack.errors import WebValidationError


class TestPreferences(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "nested" / "preferences.json"
        self._env_backup = os.environ.get("MIDITRACK_PREFERENCES_PATH")
        os.environ["MIDITRACK_PREFERENCES_PATH"] = str(self.path)
        self.addCleanup(self._restore_env)

    def _restore_env(self) -> None:
        if self._env_backup is None:
            os.environ.pop("MIDITRACK_PREFERENCES_PATH", None)
        else:
            os.environ["MIDITRACK_PREFERENCES_PATH"] = self._env_backup

    def test_preferences_path_honors_env_override(self) -> None:
        self.assertEqual(preferences.preferences_path(), self.path)

    def test_load_missing_file_returns_empty_defaults(self) -> None:
        loaded = preferences.load_preferences()
        self.assertEqual(loaded["pinnedPrograms"], [])
        self.assertEqual(loaded["usageCounts"], {})
        self.assertIsNone(loaded["selectedSoundfont"])
        self.assertEqual(loaded["displayMode"], "normal")

    def test_load_corrupt_json_returns_empty_defaults(self) -> None:
        self.path.parent.mkdir(parents=True)
        self.path.write_text("not valid json{{{", encoding="utf-8")
        self.assertEqual(preferences.load_preferences()["displayMode"], "normal")

    def test_load_non_dict_json_returns_empty_defaults(self) -> None:
        self.path.parent.mkdir(parents=True)
        self.path.write_text("[1, 2, 3]", encoding="utf-8")
        self.assertEqual(preferences.load_preferences()["displayMode"], "normal")

    def test_save_creates_parent_directories(self) -> None:
        self.assertFalse(self.path.parent.exists())
        preferences.save_preferences({"pinnedPrograms": [80]})
        self.assertTrue(self.path.exists())

    def test_save_and_reload_round_trips(self) -> None:
        preferences.save_preferences({"pinnedPrograms": [80, 40], "usageCounts": {"80": 3}})
        reloaded = preferences.load_preferences()
        self.assertEqual(reloaded["pinnedPrograms"], [80, 40])
        self.assertEqual(reloaded["usageCounts"], {"80": 3})

    def test_partial_update_preserves_other_field(self) -> None:
        preferences.save_preferences({"pinnedPrograms": [80], "usageCounts": {"80": 1}})
        preferences.save_preferences({"usageCounts": {"80": 2}})
        reloaded = preferences.load_preferences()
        self.assertEqual(reloaded["pinnedPrograms"], [80])
        self.assertEqual(reloaded["usageCounts"], {"80": 2})

    def test_pinned_programs_rejects_non_list(self) -> None:
        with self.assertRaises(WebValidationError):
            preferences.save_preferences({"pinnedPrograms": 80})

    def test_pinned_programs_rejects_bool(self) -> None:
        with self.assertRaises(WebValidationError):
            preferences.save_preferences({"pinnedPrograms": [True]})

    def test_pinned_programs_rejects_out_of_range(self) -> None:
        with self.assertRaises(WebValidationError):
            preferences.save_preferences({"pinnedPrograms": [128]})
        with self.assertRaises(WebValidationError):
            preferences.save_preferences({"pinnedPrograms": [-1]})

    def test_pinned_programs_deduplicates_preserving_order(self) -> None:
        result = preferences.save_preferences({"pinnedPrograms": [80, 40, 80]})
        self.assertEqual(result["pinnedPrograms"], [80, 40])

    def test_usage_counts_rejects_non_dict(self) -> None:
        with self.assertRaises(WebValidationError):
            preferences.save_preferences({"usageCounts": [1, 2]})

    def test_usage_counts_rejects_non_integer_key(self) -> None:
        with self.assertRaises(WebValidationError):
            preferences.save_preferences({"usageCounts": {"not-a-number": 1}})

    def test_usage_counts_rejects_out_of_range_key(self) -> None:
        with self.assertRaises(WebValidationError):
            preferences.save_preferences({"usageCounts": {"128": 1}})

    def test_usage_counts_rejects_negative_value(self) -> None:
        with self.assertRaises(WebValidationError):
            preferences.save_preferences({"usageCounts": {"80": -1}})

    def test_usage_counts_rejects_bool_value(self) -> None:
        with self.assertRaises(WebValidationError):
            preferences.save_preferences({"usageCounts": {"80": True}})

    def test_selected_soundfont_round_trips(self) -> None:
        preferences.save_preferences({"selectedSoundfont": "/path/to/font.sf2"})
        reloaded = preferences.load_preferences()
        self.assertEqual(reloaded["selectedSoundfont"], "/path/to/font.sf2")

    def test_selected_soundfont_can_be_cleared_to_none(self) -> None:
        preferences.save_preferences({"selectedSoundfont": "/path/to/font.sf2"})
        preferences.save_preferences({"selectedSoundfont": None})
        self.assertIsNone(preferences.load_preferences()["selectedSoundfont"])

    def test_selected_soundfont_update_preserves_other_fields(self) -> None:
        preferences.save_preferences({"pinnedPrograms": [80], "usageCounts": {"80": 1}})
        preferences.save_preferences({"selectedSoundfont": "/path/to/font.sf2"})
        reloaded = preferences.load_preferences()
        self.assertEqual(reloaded["pinnedPrograms"], [80])
        self.assertEqual(reloaded["usageCounts"], {"80": 1})
        self.assertEqual(reloaded["selectedSoundfont"], "/path/to/font.sf2")

    def test_selected_soundfont_rejects_non_string(self) -> None:
        with self.assertRaises(WebValidationError):
            preferences.save_preferences({"selectedSoundfont": 123})

    def test_selected_soundfont_rejects_empty_string(self) -> None:
        with self.assertRaises(WebValidationError):
            preferences.save_preferences({"selectedSoundfont": ""})

    def test_display_mode_round_trips(self) -> None:
        preferences.save_preferences({"displayMode": "fullscreen"})
        self.assertEqual(preferences.load_preferences()["displayMode"], "fullscreen")

    def test_display_mode_rejects_invalid_value(self) -> None:
        with self.assertRaises(WebValidationError):
            preferences.save_preferences({"displayMode": "windowed"})

    def test_load_non_string_selected_soundfont_falls_back_to_none(self) -> None:
        self.path.parent.mkdir(parents=True)
        self.path.write_text(
            json.dumps({"pinnedPrograms": [], "usageCounts": {}, "selectedSoundfont": 123}),
            encoding="utf-8",
        )
        self.assertIsNone(preferences.load_preferences()["selectedSoundfont"])

    def test_saved_file_is_valid_json(self) -> None:
        preferences.save_preferences({"pinnedPrograms": [1]})
        raw = self.path.read_text(encoding="utf-8")
        parsed = json.loads(raw)
        self.assertEqual(parsed["pinnedPrograms"], [1])

    def test_render_workers_defaults_to_auto(self) -> None:
        self.assertEqual(preferences.load_preferences()["renderWorkers"], "auto")

    def test_render_workers_round_trips_auto(self) -> None:
        preferences.save_preferences({"renderWorkers": 4})
        preferences.save_preferences({"renderWorkers": "auto"})
        self.assertEqual(preferences.load_preferences()["renderWorkers"], "auto")

    def test_render_workers_round_trips_integer(self) -> None:
        preferences.save_preferences({"renderWorkers": 4})
        self.assertEqual(preferences.load_preferences()["renderWorkers"], 4)

    def test_render_workers_rejects_out_of_range(self) -> None:
        with self.assertRaises(WebValidationError):
            preferences.save_preferences({"renderWorkers": 0})
        with self.assertRaises(WebValidationError):
            preferences.save_preferences({"renderWorkers": preferences.RENDER_WORKERS_MAX + 1})

    def test_render_workers_rejects_bool(self) -> None:
        with self.assertRaises(WebValidationError):
            preferences.save_preferences({"renderWorkers": True})

    def test_render_workers_rejects_non_integer_string(self) -> None:
        with self.assertRaises(WebValidationError):
            preferences.save_preferences({"renderWorkers": "4"})

    def test_load_invalid_render_workers_falls_back_to_auto(self) -> None:
        self.path.parent.mkdir(parents=True)
        self.path.write_text(json.dumps({"renderWorkers": 99}), encoding="utf-8")
        self.assertEqual(preferences.load_preferences()["renderWorkers"], "auto")


class TestResolveRenderWorkers(unittest.TestCase):
    def test_auto_uses_half_cpu_count_capped(self) -> None:
        with patch("miditrack.preferences.os.cpu_count", return_value=8):
            self.assertEqual(preferences.resolve_render_workers("auto"), 4)

    def test_auto_caps_at_render_workers_auto_cap(self) -> None:
        with patch("miditrack.preferences.os.cpu_count", return_value=32):
            self.assertEqual(
                preferences.resolve_render_workers("auto"), preferences.RENDER_WORKERS_AUTO_CAP
            )

    def test_auto_never_below_minimum(self) -> None:
        with patch("miditrack.preferences.os.cpu_count", return_value=1):
            self.assertEqual(
                preferences.resolve_render_workers("auto"), preferences.RENDER_WORKERS_MIN
            )

    def test_auto_falls_back_when_cpu_count_is_none(self) -> None:
        with patch("miditrack.preferences.os.cpu_count", return_value=None):
            self.assertGreaterEqual(preferences.resolve_render_workers("auto"), 1)

    def test_explicit_integer_is_clamped(self) -> None:
        self.assertEqual(preferences.resolve_render_workers(2), 2)
        self.assertEqual(preferences.resolve_render_workers(999), preferences.RENDER_WORKERS_MAX)
        self.assertEqual(preferences.resolve_render_workers(-1), preferences.RENDER_WORKERS_MIN)


if __name__ == "__main__":
    unittest.main()

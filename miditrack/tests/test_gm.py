"""miditrack.gm のテスト。"""

from __future__ import annotations

import unittest

from miditrack import gm


class TestGmTable(unittest.TestCase):
    def test_has_128_programs(self) -> None:
        self.assertEqual(len(gm.GM_PROGRAM_NAMES), 128)

    def test_has_16_families(self) -> None:
        self.assertEqual(len(gm.GM_FAMILY_NAMES), 16)

    def test_families_cover_128_programs_evenly(self) -> None:
        self.assertEqual(len(gm.GM_FAMILY_NAMES) * gm.PROGRAMS_PER_FAMILY, 128)

    def test_no_duplicate_names(self) -> None:
        self.assertEqual(len(set(gm.GM_PROGRAM_NAMES)), len(gm.GM_PROGRAM_NAMES))

    def test_program_80_is_lead_1_square(self) -> None:
        # vgm2midi/src/midi-converter.ts:8 の GM_PROGRAM_LEAD_1_SQUARE = 80 と整合させる。
        self.assertEqual(gm.GM_PROGRAM_NAMES[80], "Lead 1 (square)")

    def test_program_name_bounds(self) -> None:
        self.assertEqual(gm.program_name(0), "Acoustic Grand Piano")
        self.assertEqual(gm.program_name(127), "Gunshot")
        with self.assertRaises(ValueError):
            gm.program_name(-1)
        with self.assertRaises(ValueError):
            gm.program_name(128)

    def test_family_of(self) -> None:
        self.assertEqual(gm.family_of(0), "Piano")
        self.assertEqual(gm.family_of(7), "Piano")
        self.assertEqual(gm.family_of(8), "Chromatic Percussion")
        self.assertEqual(gm.family_of(80), "Synth Lead")
        self.assertEqual(gm.family_of(127), "Sound Effects")

    def test_instrument_catalog_covers_every_program_once_in_order(self) -> None:
        catalog = gm.instrument_catalog()
        self.assertEqual(len(catalog), 16)
        seen: list[int] = []
        for family in catalog:
            self.assertEqual(len(family["programs"]), gm.PROGRAMS_PER_FAMILY)
            for entry in family["programs"]:
                seen.append(entry["program"])
                self.assertEqual(entry["name"], gm.GM_PROGRAM_NAMES[entry["program"]])
        self.assertEqual(seen, list(range(128)))

    def test_percussion_channel_is_ch10_zero_indexed(self) -> None:
        self.assertEqual(gm.PERCUSSION_CHANNEL, 9)


if __name__ == "__main__":
    unittest.main()

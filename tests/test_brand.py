"""The display name can be chosen per deployment without breaking existing voice titles."""
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import brand


class Brand(unittest.TestCase):
    def test_name_is_validated_and_defaults_to_somhouse(self):
        self.assertEqual(brand.load("콩하우스"), "콩하우스")
        self.assertEqual(brand.load("  우리  집 "), "우리 집")
        for bad in ("", "a" * 21, "솜하우스<script>", "(.*)"):
            self.assertEqual(brand.load(bad), "솜하우스", bad)

    def test_voice_prefix_accepts_new_and_old_names(self):
        pattern = brand.prefix_pattern("솜하우스", "콩하우스")
        for title in ("콩하우스 수유 120", "콩 하우스: 수유", "솜하우스 수유", "솜하우스"):
            self.assertTrue(pattern.match(title), title)
        for title in ("콩하우스물 사기", "하우스 수유", "콩하우"):
            self.assertFalse(pattern.match(title), title)
        self.assertEqual(pattern.sub("", "콩 하우스: 수유 120"), "수유 120")


if __name__ == "__main__":
    unittest.main()

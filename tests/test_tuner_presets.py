from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from test_audition_review import load_module

presets = load_module("tuner_presets")


class TunerPresetTests(unittest.TestCase):
    def test_presets_persist_replace_and_keep_implicit_default_blocks(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as root, \
             patch.object(presets.folder_paths, "get_user_directory", return_value=root):
            saved = presets.save_preset("portrait", {"blocks.0": -0.5}, 0.8, ["blocks.0", "blocks.1"])
            self.assertEqual(saved["values"], {"blocks.0": -0.5, "blocks.1": 1})
            self.assertEqual(presets.list_presets(), [saved])
            presets.save_preset("portrait", {"blocks.0": 0}, 1, ["blocks.0"])
            self.assertEqual(len(presets.list_presets()), 1)
            self.assertEqual(presets.list_presets()[0]["values"]["blocks.0"], 0)
            path = presets.preset_path("../../outside")
            self.assertEqual(path.parent, Path(root) / "questionable-nodes" / "tuner_presets")
            for values, strength, blocks in [({}, 1, []), ({"wrong": 1}, 1, ["blocks.0"]),
                ({"blocks.0": float("nan")}, 1, ["blocks.0"]), ({}, float("inf"), ["blocks.0"])]:
                with self.assertRaises(ValueError):
                    presets.save_preset("bad", values, strength, blocks)

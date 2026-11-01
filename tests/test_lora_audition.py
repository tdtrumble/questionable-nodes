import asyncio
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
sys.argv = [sys.argv[0], "--cpu"]
spec = importlib.util.spec_from_file_location("lora_audition", Path(__file__).resolve().parents[1] / "lora_audition.py")
audition = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audition)

from execution import _async_map_node_over_list, merge_result_data


class LoRAAuditionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "B.safetensors").touch()
        (self.root / "a.safetensors").touch()
        (self.root / "notes.txt").touch()
        (self.root / "sub").mkdir()
        (self.root / "sub" / "c.safetensors").touch()

    def selection(self, names, recursive=False):
        return json.dumps({"directory": str(self.root), "recursive": recursive, "selected": names})

    def test_scan_and_recursion(self):
        self.assertEqual(audition.scan_directory(str(self.root), False), ["a.safetensors", "B.safetensors"])
        self.assertEqual(audition.scan_directory(str(self.root), True), ["a.safetensors", "B.safetensors", "sub/c.safetensors"])

    def test_empty_selection_fails_validation(self):
        self.assertIn("Select at least one", audition.LoRAAudition.validate_inputs(str(self.root), False, self.selection([])))

    def test_selection_boundaries(self):
        for names in [["../outside.safetensors"], [str(self.root / "a.safetensors")], ["sub/c.safetensors"], ["notes.txt"], ["missing.safetensors"]]:
            with self.subTest(names=names):
                self.assertIsInstance(audition.LoRAAudition.validate_inputs(str(self.root), False, self.selection(names)), str)
        self.assertIs(audition.LoRAAudition.validate_inputs(str(self.root), True, self.selection(["sub/c.safetensors"], True)), True)

    def test_changed_settings_and_malformed_selection(self):
        self.assertIsInstance(audition.LoRAAudition.validate_inputs(str(self.root), True, self.selection(["a.safetensors"])), str)
        for value in ["bad json", "[]", '{"selected":true}', '{"selected":[5]}']:
            self.assertIsInstance(audition.LoRAAudition.validate_inputs(str(self.root), False, value), str)

    def test_file_changes_invalidate_cache(self):
        selection = self.selection(["a.safetensors"])
        before = audition.LoRAAudition.fingerprint_inputs(str(self.root), False, selection)
        (self.root / "a.safetensors").write_bytes(b"changed")
        after = audition.LoRAAudition.fingerprint_inputs(str(self.root), False, selection)
        self.assertNotEqual(before, after)

    def test_symlink_cannot_escape_directory(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as outside:
            target = Path(outside) / "outside.safetensors"
            target.touch()
            try:
                (self.root / "escape.safetensors").symlink_to(target)
            except OSError:
                self.skipTest("Symlinks require Windows developer mode or administrator privileges")
            self.assertNotIn("escape.safetensors", audition.scan_directory(str(self.root), True))
            self.assertIsInstance(audition.LoRAAudition.validate_inputs(str(self.root), True, self.selection(["escape.safetensors"], True)), str)

    def test_independent_loras_and_native_list_alignment(self):
        model, clip = object(), object()
        def apply(base_model, base_clip, weights, strength_model, strength_clip, lora_metadata):
            self.assertIs(base_model, model)
            self.assertIs(base_clip, clip)
            self.assertEqual((strength_model, strength_clip), (0.8, 0.6))
            self.assertEqual(lora_metadata, {"name": weights})
            return f"model:{weights}", f"clip:{weights}"
        with patch.object(audition.comfy.utils, "load_torch_file", side_effect=lambda path, **kwargs: (Path(path).stem, {"name": Path(path).stem})) as load:
            with patch.object(audition.comfy.sd, "load_lora_for_models", side_effect=apply):
                output = audition.LoRAAudition.execute(model, clip, str(self.root), False, 0.8, 0.6, self.selection(["B.safetensors", "a.safetensors"]))
        self.assertEqual(load.call_count, 2)
        self.assertEqual(audition.LoRAAudition.OUTPUT_IS_LIST, [True, True, True])
        merged = merge_result_data([output.result], audition.LoRAAudition)
        class NativeConsumer:
            def execute(self, model, clip, filename, seed):
                return (model, clip, filename, seed)
        results = asyncio.run(_async_map_node_over_list("test", "consumer", NativeConsumer(),
            dict(zip(["model", "clip", "filename"], merged)) | {"seed": [42]}, "execute"))
        self.assertEqual(results, [("model:a", "clip:a", "a", 42), ("model:B", "clip:B", "B", 42)])

    def test_zero_strength_still_outputs_every_selected_name(self):
        with patch.object(audition.comfy.utils, "load_torch_file") as load:
            output = audition.LoRAAudition.execute("model", "clip", str(self.root), False, 0, 0, self.selection(["a.safetensors", "B.safetensors"]))
        load.assert_not_called()
        self.assertEqual(output.result, (["model", "model"], ["clip", "clip"], ["a", "B"]))


if __name__ == "__main__":
    unittest.main()

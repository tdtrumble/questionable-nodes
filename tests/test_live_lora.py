import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import torch
from test_audition_review import load_module
from comfy.weight_adapter.lora import LoRAAdapter

live = load_module("live_lora")


class Model:
    def clone(self):
        return Model()

    def add_patches(self, patches, strength):
        self.applied = getattr(self, "applied", []) + [(patches, strength)]
        return list(patches)


class LiveLoRATests(unittest.TestCase):
    def test_native_lora_loader_and_file_boundary(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as root:
            path = Path(root) / "test.safetensors"
            live.comfy.utils.save_torch_file({"test.lora_up.weight": torch.ones(3, 2),
                "test.lora_down.weight": torch.ones(2, 3)}, str(path))
            model = Model()
            model.model = object()
            with patch.object(live.folder_paths, "get_full_path_or_raise", return_value=str(path)) as resolve, \
                 patch.object(live.comfy.lora, "model_lora_keys_unet", return_value={"test": "diffusion_model.blocks.0.q.weight"}):
                weights, metadata, patches = live.load_patches(model, "test.safetensors")
                resolve.assert_called_once_with("loras", "test.safetensors")
                self.assertIsInstance(patches["diffusion_model.blocks.0.q.weight"], LoRAAdapter)
                saved = live.baked_weights(weights, patches, {"blocks.0": 0.5}, 1)
                torch.testing.assert_close(saved["test.lora_up.weight"], torch.full((3, 2), 0.5))

    def test_grouping_native_keys_and_patch_strength(self):
        keys = ["diffusion_model.blocks.2.attn.wq.weight", "diffusion_model.txtfusion.refiner_blocks.1.attn.wq.weight",
            ("diffusion_model.double_blocks.3.qkv.weight", (0, 0, 4)), "diffusion_model.first.weight"]
        patches = dict.fromkeys(keys, "patch")
        model, groups = live.apply_blocks(Model(), patches, {"blocks.2": -0.5}, 0.8)
        self.assertEqual([entry[1] for entry in model.applied], [-0.4, 0.8, 0.8, 0.8])
        self.assertEqual(len(groups), 4)
        with self.assertRaises(ValueError):
            live.apply_blocks(Model(), patches, {"wrong": 1}, 1)
        for value in ['[]', '{"a":true}', '{"a":NaN}']:
            with self.assertRaises(ValueError):
                live.strengths(value)

    def test_export_scales_only_up_factor_preserving_negative_weights(self):
        up, down = torch.ones(3, 2), torch.ones(2, 3)
        patch = LoRAAdapter(set(), (up, down, 2, None, None, None))
        weights = {"test.lora_up.weight": up, "test.lora_down.weight": down, "test.alpha": torch.tensor(2)}
        result = live.baked_weights(weights, {"diffusion_model.blocks.0.q.weight": patch}, {"blocks.0": -0.5}, 0.8)
        torch.testing.assert_close(result["test.lora_up.weight"], up * -0.4)
        self.assertIs(result["test.lora_down.weight"], down)
        torch.testing.assert_close(up, torch.ones(3, 2))
        patch.weights = (up, down, 2, None, torch.ones(3), None)
        with self.assertRaises(ValueError):
            live.baked_weights(weights, {"blocks.0.q.weight": patch}, {}, 1)

    def test_preview_verify_and_export_use_native_paths(self):
        live.LiveLoRATuner.GET_NODE_INFO_V1()
        up, down = torch.ones(3, 2), torch.ones(2, 3)
        weights = {"test.lora_up.weight": up, "test.lora_down.weight": down}
        patches = {"diffusion_model.blocks.0.q.weight": LoRAAdapter(set(), (up, down, 2, None, None, None))}
        latent, smaller = {"samples": torch.zeros(1, 4, 8, 8)}, {"samples": torch.zeros(1, 4, 4, 4)}
        class VAE:
            def decode(self, samples):
                return torch.zeros(1, 8, 8, 3)
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as root:
            with patch.object(live, "load_patches", return_value=(weights, {}, patches)), \
                 patch.object(live.nodes, "common_ksampler", return_value=(latent,)) as sample, \
                 patch.object(live.folder_paths, "get_output_directory", return_value=root), \
                 patch.object(live.folder_paths, "get_temp_directory", return_value=root):
                inputs = dict(model=Model(), positive=[], negative=[], latent=latent, vae=VAE(), lora_name="test.safetensors", preview_latent=smaller)
                output = live.LiveLoRATuner.execute(**inputs)
                self.assertEqual(sample.call_args.args[2], 4)
                self.assertIs(sample.call_args.args[8], smaller)
                self.assertEqual(output.ui["live_lora"][0]["blocks"], ["blocks.0"])
                live.LiveLoRATuner.execute(**inputs, action="verify")
                self.assertEqual(sample.call_args.args[2], 20)
                self.assertIs(sample.call_args.args[8], latent)
                sample.reset_mock()
                exported = live.LiveLoRATuner.execute(**inputs, action="export", block_strengths=json.dumps({"blocks.0": -0.5}))
                sample.assert_not_called()
                path = Path(root) / exported.ui["live_lora"][0]["saved"]
                saved = live.comfy.utils.load_torch_file(str(path), safe_load=True)
                torch.testing.assert_close(saved["test.lora_up.weight"], up * -0.5)

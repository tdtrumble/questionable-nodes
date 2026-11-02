import asyncio
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import test_lora_audition
import torch
from execution import _async_map_node_over_list, merge_result_data


def load_module(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).resolve().parents[1] / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


prompts = load_module("audition_prompts")
review = load_module("audition_review")
audition = test_lora_audition.audition


class AuditionReviewTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.output = patch.object(review.folder_paths, "get_output_directory", return_value=str(self.root))
        self.output.start()
        self.addCleanup(self.output.stop)
        for name in ["epoch2.safetensors", "epoch1.safetensors"]:
            (self.root / name).write_bytes(name.encode())
        self.selection = json.dumps({"directory": str(self.root), "recursive": False,
            "selected": ["epoch2.safetensors", "epoch1.safetensors"]})

    def expand(self, texts=None):
        request = prompts.AuditionPromptList.execute(json.dumps(texts or ["portrait\nindoors", "landscape"]), 123).result[0]
        return audition.LoRAAudition.execute(model="model", directory=str(self.root), strength_model=0,
            selection=self.selection, prompts=request).result

    def test_prompt_validation_and_no_fixed_limit(self):
        values = [f"prompt {index}" for index in range(150)]
        self.assertEqual(prompts.AuditionPromptList.execute(json.dumps(values), 42).result[0]["prompts"], values)
        for value in ['{}', '[1]', '["  "]']:
            with self.assertRaises(ValueError):
                prompts.AuditionPromptList.execute(value, 42)

    def test_cartesian_order_and_checkpoint_identity(self):
        output = self.expand()
        self.assertEqual(output[2], ["epoch2", "epoch1", "epoch2", "epoch1"])
        self.assertEqual(output[3], ["portrait\nindoors"] * 2 + ["landscape"] * 2)
        self.assertEqual(output[4], [123] * 4)
        self.assertEqual(output[5][0]["candidate"], output[5][2]["candidate"])
        old = output[5][0]["candidate"]["id"]
        (self.root / "epoch2.safetensors").write_bytes(b"new checkpoint")
        self.assertNotEqual(old, self.expand()[5][0]["candidate"]["id"])

    def test_images_persist_votes_replace_and_changed_sets_remain_separate(self):
        comparison = self.expand()[5]
        images = [torch.full((2, 4, 4, 3), index / 4) for index in range(4)]
        output = review.AuditionReview.execute(images, comparison, ["test session"])
        session = output.ui["audition_session"][0]
        self.assertEqual(len(session["cards"]), 4)
        first = session["cards"][0]
        self.assertEqual([item["name"] for item in first["candidates"]], ["epoch2.safetensors", "epoch1.safetensors"])
        for card in session["cards"]:
            for candidate in card["candidates"]:
                image = candidate["image"]
                self.assertTrue((self.root / image["subfolder"] / image["filename"]).is_file())
        a, b = [item["id"] for item in first["candidates"]]
        for _ in range(2):
            review.save_votes("test session", {first["id"]: a})
        self.assertEqual(review.ranking(review.read_session("test session"))[0]["wins"], 1)
        session = review.save_votes("test session", {first["id"]: b})
        self.assertEqual(review.ranking(session)[0]["id"], b)
        self.assertEqual(sum(row["wins"] for row in review.ranking(session)), 1)
        with self.assertRaises(ValueError):
            review.save_votes("test session", {first["id"]: "wrong checkpoint"})
        subset = comparison[:1]
        review.AuditionReview.execute(images[:1], subset, ["test session"])
        session = review.read_session("test session")
        self.assertEqual(len(session["cards"]), 6)
        self.assertEqual(len(review.session_view(session)["rankings"]), 3)
        session = review.save_votes("test session", {first["id"]: None})
        self.assertEqual(sum(row["wins"] for row in review.ranking(session)), 0)

    def test_session_names_are_contained_and_mismatch_fails(self):
        path = review.session_path("../../escape")
        self.assertEqual(path.parent, self.root / "audition_sessions")
        with self.assertRaises(ValueError):
            review.AuditionReview.execute([], self.expand()[5], ["test"])

    def test_native_v3_execution_preserves_prompt_model_and_image_alignment(self):
        for node in [prompts.AuditionPromptList, audition.LoRAAudition, review.AuditionReview]:
            node.GET_NODE_INFO_V1()
        async def run():
            inputs = {"model": ["base"], "directory": [str(self.root)], "selection": [self.selection],
                "strength_model": [0], "prompts": [{"prompts": ["first", "second"], "seed": 123}]}
            outputs = await _async_map_node_over_list("test", "audition", audition.LoRAAudition, inputs, "execute")
            values = merge_result_data([item.result for item in outputs], audition.LoRAAudition)
            class Generation:
                def execute(self, model, text, seed):
                    self_test.assertEqual(model, "base")
                    self_test.assertEqual(seed, 123)
                    return (torch.full((1, 4, 4, 3), 0.2 if text == "first" else 0.8),)
            self_test = self
            generated = await _async_map_node_over_list("test", "generation", Generation(),
                {"model": values[0], "text": values[3], "seed": values[4]}, "execute")
            results = await _async_map_node_over_list("test", "review", review.AuditionReview,
                {"images": [item[0] for item in generated], "comparison": values[5], "session": ["native"]}, "execute")
            return results[0].ui["audition_session"][0]
        document = asyncio.run(run())
        self.assertEqual([card["prompt"] for card in document["cards"]], ["first", "second"])
        self.assertTrue(all(len(card["candidates"]) == 2 for card in document["cards"]))


if __name__ == "__main__":
    unittest.main()

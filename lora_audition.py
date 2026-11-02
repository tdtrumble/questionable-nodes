import hashlib
import json
from pathlib import Path

import comfy.sd
import comfy.utils
import folder_paths
from comfy_api.latest import io


def directory_path(directory):
    if not directory.strip():
        raise ValueError("Enter a LoRA directory and click Scan.")
    root = Path(directory.strip()).expanduser().resolve(strict=True)
    if not root.is_dir():
        raise ValueError("The LoRA directory must be a folder.")
    return root


def lora_path(root, name, recursive):
    relative = Path(name)
    if relative.is_absolute() or relative.drive or ".." in relative.parts:
        raise ValueError("LoRA selections must be relative paths inside the scanned directory.")
    path = (root / relative).resolve(strict=True)
    if not path.is_relative_to(root) or (not recursive and path.parent != root):
        raise ValueError(f"LoRA is outside the scanned directory: {name}")
    if not path.is_file() or path.suffix.lower() not in folder_paths.supported_pt_extensions:
        raise ValueError(f"Not a supported LoRA file: {name}")
    return path


def scan_directory(directory, recursive):
    root = directory_path(directory)
    files = []
    entries = root.rglob("*") if recursive else root.iterdir()
    for entry in entries:
        if entry.is_file() and entry.suffix.lower() in folder_paths.supported_pt_extensions:
            if entry.resolve().is_relative_to(root):
                files.append(entry.relative_to(root).as_posix())
    return sorted(files, key=lambda name: (name.casefold(), name))


def selected_paths(directory, recursive, selection):
    state = json.loads(selection)
    if not isinstance(state, dict) or not isinstance(state.get("selected"), list):
        raise ValueError("Invalid LoRA selection. Click Scan again.")
    names = state["selected"]
    if not names:
        raise ValueError("Select at least one LoRA in LoRA Audition.")
    if state.get("directory") != directory or state.get("recursive") != recursive:
        raise ValueError("The scan settings changed. Click Scan and select your LoRAs again.")
    if any(not isinstance(name, str) or not name for name in names):
        raise ValueError("Invalid LoRA selection. Click Scan again.")
    root = directory_path(directory)
    return [lora_path(root, name, recursive) for name in dict.fromkeys(names)]


class LoRAAudition(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="QuestionableLoRAAudition",
            display_name="LoRA Audition",
            category="Questionable Nodes/loaders",
            description="Try checked LoRAs independently in displayed order. Attach Audition Prompt List to run every prompt against every LoRA.",
            search_aliases=["lora", "folder", "compare", "batch"],
            inputs=[
                io.Model.Input("model"),
                io.Clip.Input("clip", optional=True),
                io.String.Input("directory", default="", tooltip="Directory on the ComfyUI server's machine."),
                io.Boolean.Input("recursive", default=False),
                io.Float.Input("strength_model", default=1.0, min=-100.0, max=100.0, step=0.01),
                io.Float.Input("strength_clip", default=1.0, min=-100.0, max=100.0, step=0.01),
                io.String.Input("selection", default='{"selected":[]}', socketless=True),
                io.Custom("AUDITION_PROMPTS").Input("prompts", optional=True),
            ],
            outputs=[
                io.Model.Output(is_output_list=True),
                io.Clip.Output(is_output_list=True),
                io.String.Output(display_name="filename", is_output_list=True),
                io.String.Output(display_name="prompt", is_output_list=True),
                io.Int.Output(display_name="seed", is_output_list=True),
                io.Custom("AUDITION_COMPARISON").Output(display_name="comparison", is_output_list=True),
            ],
        )

    @classmethod
    def validate_inputs(cls, directory, recursive, selection):
        try:
            selected_paths(directory, recursive, selection)
        except (OSError, ValueError) as error:
            return str(error)
        return True

    @classmethod
    def fingerprint_inputs(cls, directory, recursive, selection):
        return tuple((str(path), path.stat().st_mtime_ns, path.stat().st_size)
                     for path in selected_paths(directory, recursive, selection))

    @classmethod
    def execute(cls, model, clip=None, directory="", recursive=False, strength_model=1.0, strength_clip=1.0, selection='{"selected":[]}', prompts=None):
        models, clips, filenames = [], [], []
        paths = selected_paths(directory, recursive, selection)
        for path in paths:
            if strength_model == 0 and (clip is None or strength_clip == 0):
                patched_model, patched_clip = model, clip
            else:
                lora, metadata = comfy.utils.load_torch_file(str(path), safe_load=True, return_metadata=True)
                patched_model, patched_clip = comfy.sd.load_lora_for_models(
                    model, clip, lora, strength_model, strength_clip, lora_metadata=metadata)
            models.append(patched_model)
            clips.append(patched_clip)
            filenames.append(path.stem)
        if prompts is None:
            return io.NodeOutput(models, clips, filenames, [""], [42], [])
        candidates = []
        for path in paths:
            digest = hashlib.sha256()
            with path.open("rb") as weights:
                for chunk in iter(lambda: weights.read(1024 * 1024), b""):
                    digest.update(chunk)
            identity = hashlib.sha256((str(path) + ":" + digest.hexdigest()).encode()).hexdigest()
            candidates.append({"id": identity, "name": path.relative_to(directory_path(directory)).as_posix()})
        texts, seeds, comparisons = [], [], []
        for prompt_index, text in enumerate(prompts["prompts"]):
            for candidate in candidates:
                texts.append(text)
                seeds.append(prompts["seed"])
                comparisons.append({"prompt_index": prompt_index, "prompt": text, "seed": prompts["seed"],
                    "candidate": candidate, "strength_model": strength_model, "strength_clip": strength_clip})
        count = len(prompts["prompts"])
        return io.NodeOutput(models * count, clips * count, filenames * count, texts, seeds, comparisons)

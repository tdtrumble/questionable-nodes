import hashlib
import json
import math
import os
from pathlib import Path
import threading

import folder_paths


PRESET_LOCK = threading.Lock()


def preset_path(name):
    if not isinstance(name, str) or not name.strip():
        raise ValueError("Enter a preset name.")
    root = Path(folder_paths.get_user_directory()) / "questionable-nodes" / "tuner_presets"
    root.mkdir(parents=True, exist_ok=True)
    return root / (hashlib.sha256(name.strip().encode()).hexdigest() + ".json")


def list_presets():
    with PRESET_LOCK:
        return sorted((json.loads(path.read_text(encoding="utf-8")) for path in preset_path("index").parent.glob("*.json")),
                      key=lambda item: item["name"].casefold())


def save_preset(name, values, strength, blocks):
    if not isinstance(values, dict) or any(not isinstance(key, str) or isinstance(value, bool)
        or not isinstance(value, (int, float)) or not math.isfinite(value) for key, value in values.items()):
        raise ValueError("Preset adjustments must be finite numbers keyed by block name.")
    if isinstance(strength, bool) or not isinstance(strength, (int, float)) or not math.isfinite(strength):
        raise ValueError("Preset strength must be a finite number.")
    if not isinstance(blocks, list) or not blocks or any(not isinstance(block, str) for block in blocks):
        raise ValueError("Start a preview to discover the LoRA blocks before saving a preset.")
    if values.keys() - set(blocks):
        raise ValueError("Adjustments do not match the current LoRA blocks. Start a new preview.")
    path = preset_path(name)
    preset = {"name": name.strip(), "strength": strength, "blocks": sorted(set(blocks)),
              "values": {block: values.get(block, 1.0) for block in sorted(set(blocks))}}
    with PRESET_LOCK:
        temporary = path.with_suffix(".tmp")
        temporary.write_text(json.dumps(preset, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(temporary, path)
    return preset

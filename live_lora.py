import json
import math
import os
import re
import uuid

import comfy.lora
import comfy.lora_convert
import comfy.model_base
import comfy.samplers
import comfy.utils
import folder_paths
import nodes
from comfy.weight_adapter.lora import LoRAAdapter
from comfy_api.latest import io, ui


def block_name(key):
    name = key[0] if isinstance(key, tuple) else key
    match = re.search(r"(?:^|\.)(?:(?:txtfusion\.)?(?:layerwise_blocks|refiner_blocks)|double_blocks|single_blocks|transformer_blocks|blocks|layers|input_blocks|output_blocks)\.\d+", name)
    return match.group().lstrip(".") if match else "other_weights"


def strengths(value):
    result = json.loads(value)
    if not isinstance(result, dict) or any(not isinstance(key, str) or isinstance(weight, bool)
        or not isinstance(weight, (int, float)) or not math.isfinite(weight) for key, weight in result.items()):
        raise ValueError("Block strengths must be finite numbers keyed by block name.")
    return result


def load_patches(model, lora_name):
    path = folder_paths.get_full_path_or_raise("loras", lora_name)
    weights, metadata = comfy.utils.load_torch_file(path, safe_load=True, return_metadata=True)
    weights = comfy.lora_convert.convert_lora(weights)
    keys = comfy.lora.model_lora_keys_unet(model.model, {})
    patches = comfy.lora.load_lora(weights, keys)
    if not patches:
        raise ValueError("No model LoRA weights matched. Select a LoRA compatible with the incoming MODEL.")
    return weights, metadata, patches


def apply_blocks(model, patches, values, strength):
    groups = {}
    for key, patch in patches.items():
        groups.setdefault(block_name(key), {})[key] = patch
    unknown = values.keys() - groups.keys()
    if unknown:
        raise ValueError("The LoRA blocks changed. Reset sliders and start preview again.")
    patched = model.clone()
    for name, group in groups.items():
        accepted = patched.add_patches(group, strength * values.get(name, 1.0))
        if set(accepted) != set(group):
            raise ValueError(f"Some LoRA weights in {name} could not be applied to this model.")
    return patched, sorted(groups, key=lambda name: re.sub(r"\d+", lambda match: match.group().zfill(6), name))


def baked_weights(weights, patches, values, strength):
    output = dict(weights)
    tensor_names = {}
    for name, tensor in weights.items():
        tensor_names.setdefault(id(tensor), []).append(name)
    seen = set()
    for key, patch in patches.items():
        if not isinstance(patch, LoRAAdapter) or patch.weights[4] is not None:
            raise ValueError("Export currently supports standard LoRA only, without DoRA. Preview supports native model patches.")
        up = patch.weights[0]
        names = tensor_names.get(id(up), [])
        if len(names) != 1:
            raise ValueError("Cannot identify a unique LoRA output factor for export.")
        name = names[0]
        if name in seen:
            raise ValueError("Shared LoRA factors cannot be exported with independent block strengths.")
        seen.add(name)
        output[name] = up * (strength * values.get(block_name(key), 1.0))
    return output


def trainer_targets(model, patches):
    native = {}
    for key in patches:
        name = key[0] if isinstance(key, tuple) else key
        if name.endswith(".weight"):
            native.setdefault(block_name(key), set()).add(name.removeprefix("diffusion_model.")[:-7])
    family = "unknown"
    mapping = {}
    if isinstance(model, comfy.model_base.Krea2):
        family = "krea2"
        mapping = comfy.utils.krea2_to_diffusers(model.model_config.unet_config, output_prefix="diffusion_model.")
    elif isinstance(model, comfy.model_base.Flux):
        family = "flux2" if isinstance(model, comfy.model_base.Flux2) else "flux"
        mapping = comfy.utils.flux_to_diffusers(model.model_config.unet_config, output_prefix="diffusion_model.")
    elif isinstance(model, (comfy.model_base.SDXL, comfy.model_base.SDXLRefiner)):
        family = "sdxl"
        mapping = {key: "diffusion_model." + value for key, value in comfy.utils.unet_to_diffusers(model.model_config.unet_config).items()}
    reverse, fused = {}, {}
    for alias, target in mapping.items():
        if alias.endswith(".weight"):
            reverse.setdefault(target, set()).add(alias[:-7])
            if isinstance(target, tuple):
                fused.setdefault(target[0], set()).add(alias[:-7])
    diffusers, unmapped = {}, set()
    for key in patches:
        aliases = reverse.get(key, set()) | (fused.get(key, set()) if isinstance(key, str) else set())
        if aliases:
            diffusers.setdefault(block_name(key), set()).update(aliases)
        else:
            unmapped.add(block_name(key))
    for group in unmapped:
        diffusers.pop(group, None)
    native = {key: sorted(value) for key, value in native.items()}
    diffusers = {key: sorted(value) for key, value in diffusers.items()}
    return {"family": family, "native": native, "diffusers": diffusers}


class LiveLoRATuner(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="QuestionableLiveLoRATuner", display_name="Live LoRA Tuner",
            category="Questionable Nodes/audition", is_output_node=True,
            description="Adjust model LoRA blocks with automatic queued previews. Connect a model without this LoRA already applied. No retraining or activation-cache approximation.",
            inputs=[io.Model.Input("model"), io.Conditioning.Input("positive"), io.Conditioning.Input("negative"),
                io.Latent.Input("latent"), io.Vae.Input("vae"),
                io.Combo.Input("lora_name", options=folder_paths.get_filename_list("loras")),
                io.Float.Input("strength", default=1.0, min=-100, max=100, step=0.05),
                io.Int.Input("seed", default=42, min=0, max=0xffffffffffffffff),
                io.Int.Input("preview_steps", default=4, min=1, max=10000),
                io.Int.Input("verify_steps", default=20, min=1, max=10000),
                io.Float.Input("cfg", default=1.0, min=0, max=100, step=0.1),
                io.Combo.Input("sampler_name", options=comfy.samplers.KSampler.SAMPLERS),
                io.Combo.Input("scheduler", options=comfy.samplers.KSampler.SCHEDULERS),
                io.Float.Input("denoise", default=1.0, min=0, max=1, step=0.01),
                io.String.Input("block_strengths", default="{}", socketless=True),
                io.String.Input("action", default="preview", socketless=True),
                io.Latent.Input("preview_latent", optional=True, tooltip="Optional smaller latent for faster previews; verification uses latent."),
            ], outputs=[io.Model.Output(display_name="tuned_model"), io.Image.Output()],
        )

    @classmethod
    def fingerprint_inputs(cls, lora_name, action="preview", **kwargs):
        if action == "export":
            return float("nan")
        path = folder_paths.get_full_path_or_raise("loras", lora_name)
        stat = os.stat(path)
        return (stat.st_mtime_ns, stat.st_size)

    @classmethod
    def execute(cls, model, positive, negative, latent, vae, lora_name, strength=1.0, seed=42,
                preview_steps=4, verify_steps=20, cfg=1.0, sampler_name="euler", scheduler="normal",
                denoise=1.0, block_strengths="{}", action="preview", preview_latent=None):
        if action not in {"preview", "verify", "export"}:
            raise ValueError("Unknown live preview action.")
        values = strengths(block_strengths)
        weights, metadata, patches = load_patches(model, lora_name)
        patched, groups = apply_blocks(model, patches, values, strength)
        info = {"blocks": groups, "action": action, "lora": lora_name,
                "trainer_targets": trainer_targets(model.model, patches)}
        if action == "export":
            output = baked_weights(weights, patches, values, strength)
            root, filename, _, subfolder, _ = folder_paths.get_save_image_path(
                "audition_loras/tuned_" + uuid.uuid4().hex, folder_paths.get_output_directory())
            from_path = os.path.join(root, filename + ".safetensors")
            comfy.utils.save_torch_file(output, from_path, metadata={**(metadata or {}),
                "questionable_blocks": json.dumps(values), "questionable_strength": str(strength), "questionable_source": lora_name})
            info["saved"] = subfolder + "/" + filename + ".safetensors"
            return io.NodeOutput(patched, None, ui={"live_lora": [info]})
        samples = preview_latent if action == "preview" and preview_latent is not None else latent
        steps = preview_steps if action == "preview" else verify_steps
        result = nodes.common_ksampler(patched, seed, steps, cfg, sampler_name, scheduler,
            positive, negative, samples, denoise=denoise)[0]
        images = vae.decode(result["samples"])
        preview = ui.PreviewImage(images).as_dict()
        return io.NodeOutput(patched, images, ui={**preview, "live_lora": [info]})

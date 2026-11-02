import json

from comfy_api.latest import io


class AuditionPromptList(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="QuestionableAuditionPromptList", display_name="Audition Prompt List",
            category="Questionable Nodes/audition",
            description="Enter any number of prompts. Connect prompts to LoRA Audition to compare every prompt against every selected LoRA in one job.",
            inputs=[
                io.String.Input("prompts", default='[""]', socketless=True),
                io.Int.Input("seed", default=42, min=0, max=0xffffffffffffffff),
            ],
            outputs=[io.Custom("AUDITION_PROMPTS").Output(display_name="prompts")],
        )

    @classmethod
    def execute(cls, prompts, seed):
        values = json.loads(prompts)
        if not isinstance(values, list) or any(not isinstance(value, str) for value in values):
            raise ValueError("Prompts must be a list of strings.")
        values = [value for value in values if value.strip()]
        if not values:
            raise ValueError("Enter at least one prompt.")
        return io.NodeOutput({"prompts": values, "seed": seed})

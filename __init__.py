from comfy_api.latest import ComfyExtension, io

from .lora_audition import LoRAAudition
from .audition_prompts import AuditionPromptList
from .audition_review import AuditionReview
from .live_lora import LiveLoRATuner
from . import routes

WEB_DIRECTORY = "./web"


class QuestionableNodes(ComfyExtension):
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return [LoRAAudition, AuditionPromptList, AuditionReview, LiveLoRATuner]


async def comfy_entrypoint() -> QuestionableNodes:
    return QuestionableNodes()

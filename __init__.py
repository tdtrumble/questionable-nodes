from comfy_api.latest import ComfyExtension, io

from .lora_audition import LoRAAudition
from . import routes

WEB_DIRECTORY = "./web"


class QuestionableNodes(ComfyExtension):
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return [LoRAAudition]


async def comfy_entrypoint() -> QuestionableNodes:
    return QuestionableNodes()

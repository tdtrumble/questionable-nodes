import asyncio

from aiohttp import web
from server import PromptServer

from .lora_audition import scan_directory


@PromptServer.instance.routes.post("/questionable-nodes/loras/scan")
async def scan_loras(request):
    try:
        data = await request.json()
        if not isinstance(data, dict) or not isinstance(data.get("directory"), str) or not isinstance(data.get("recursive", False), bool):
            return web.json_response({"error": "Provide a directory and a recursive checkbox value."}, status=400)
        files = await asyncio.to_thread(scan_directory, data["directory"], data.get("recursive", False))
    except (OSError, ValueError) as error:
        return web.json_response({"error": str(error)}, status=400)
    return web.json_response({"files": files})

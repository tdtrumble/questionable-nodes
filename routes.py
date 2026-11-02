import asyncio

from aiohttp import web
from server import PromptServer

from .lora_audition import scan_directory
from .audition_review import SESSION_LOCK, read_session, save_votes, session_view


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


@PromptServer.instance.routes.post("/questionable-nodes/audition/session")
async def load_audition_session(request):
    try:
        data = await request.json()
        with SESSION_LOCK:
            session = read_session(data["name"])
        return web.json_response(session_view(session))
    except (OSError, ValueError, KeyError, TypeError) as error:
        return web.json_response({"error": str(error)}, status=400)


@PromptServer.instance.routes.post("/questionable-nodes/audition/votes")
async def update_audition_votes(request):
    try:
        data = await request.json()
        session = await asyncio.to_thread(save_votes, data["name"], data["votes"])
        return web.json_response(session_view(session))
    except (OSError, ValueError, KeyError, TypeError) as error:
        return web.json_response({"error": str(error)}, status=400)

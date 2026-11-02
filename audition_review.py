import hashlib
import json
import os
from pathlib import Path
import threading
import uuid

import folder_paths
from comfy_api.latest import io, ui


SESSION_LOCK = threading.Lock()


def session_path(name):
    if not isinstance(name, str) or not name.strip():
        raise ValueError("Enter an evaluation session name.")
    root = Path(folder_paths.get_output_directory()) / "audition_sessions"
    root.mkdir(parents=True, exist_ok=True)
    return root / (hashlib.sha256(name.strip().encode()).hexdigest() + ".json")


def read_session(name):
    path = session_path(name)
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return {"name": name.strip(), "cards": []}


def write_session(session):
    path = session_path(session["name"])
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(session, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, path)


def candidate_set(card):
    return ":".join(sorted(item["id"] for item in card["candidates"]))


def ranking(session, group=None):
    scores = {}
    for card in session["cards"]:
        if group is not None and candidate_set(card) != group:
            continue
        for item in card["candidates"]:
            score = scores.setdefault(item["id"], {"id": item["id"], "name": item["name"], "wins": 0, "entered": 0})
            if card["winner"] is not None:
                score["entered"] += 1
                score["wins"] += card["winner"] == item["id"]
    result = sorted(scores.values(), key=lambda score: (-score["wins"], score["name"], score["id"]))
    previous = None
    for index, score in enumerate(result):
        if score["wins"] != previous:
            rank = index + 1
        score["rank"] = rank
        previous = score["wins"]
    return result


def save_votes(name, votes):
    if not isinstance(votes, dict):
        raise ValueError("Votes must map comparison cards to checkpoint identities.")
    with SESSION_LOCK:
        session = read_session(name)
        cards = {card["id"]: card for card in session["cards"]}
        for card_id, winner in votes.items():
            if card_id not in cards or (winner is not None and winner not in {item["id"] for item in cards[card_id]["candidates"]}):
                raise ValueError("A vote does not belong to this comparison.")
        for card_id, winner in votes.items():
            cards[card_id]["winner"] = winner
        write_session(session)
        return session


def session_view(session):
    groups = {candidate_set(card) for card in session["cards"]}
    return {**session, "rankings": {"all": ranking(session), **{group: ranking(session, group) for group in groups}}}


class AuditionReview(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="QuestionableAuditionReview", display_name="Audition Review",
            category="Questionable Nodes/audition", is_output_node=True, is_input_list=True,
            description="Browse each prompt's LoRA candidates, choose winners, and save rankings in a named local session.",
            inputs=[io.Image.Input("images"), io.Custom("AUDITION_COMPARISON").Input("comparison"),
                    io.String.Input("session", default="LoRA evaluation")], outputs=[],
        )

    @classmethod
    def fingerprint_inputs(cls, **kwargs):
        return float("nan")

    @classmethod
    def execute(cls, images, comparison, session):
        if len(images) != len(comparison) or not comparison:
            raise ValueError("Connect matching image and comparison lists from LoRA Audition with Prompt List attached.")
        name = session[0]
        session_path(name)
        run = uuid.uuid4().hex
        cards = {}
        for batch, info in zip(images, comparison):
            saved = ui.ImageSaveHelper.get_save_images_ui(batch, f"audition/{run}", cls=None).results
            for batch_index, image in enumerate(saved):
                key = (info["prompt_index"], batch_index)
                card = cards.setdefault(key, {"id": f"{run}:{key[0]}:{key[1]}", "run": run,
                    "prompt": info["prompt"], "seed": info["seed"], "sample": batch_index + 1,
                    "strength_model": info["strength_model"], "strength_clip": info["strength_clip"],
                    "candidates": [], "winner": None})
                if info["candidate"]["id"] in {item["id"] for item in card["candidates"]}:
                    raise ValueError("Comparison entries were duplicated. Keep image and comparison list order aligned.")
                card["candidates"].append({**info["candidate"], "image": dict(image)})
        with SESSION_LOCK:
            document = read_session(name)
            document["cards"].extend(cards.values())
            write_session(document)
        return io.NodeOutput(ui={"audition_session": [session_view(document)]})

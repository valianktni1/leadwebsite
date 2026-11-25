"""Poll the private studio queue and hand each design brief to the linked Codex chat."""
import json
import logging
import re
import shutil
import uuid
import unicodedata
import os
from pathlib import Path
import sqlite3
import subprocess
import time
from urllib.request import HTTPRedirectHandler, Request, build_opener

ORIGIN = "https://websites.ivorydigital.uk"
ROOT = Path(os.environ["LOCALAPPDATA"]) / "IvoryDigital" / "DesignConnector"


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


def call(payload):
    request = Request(ORIGIN + "/api/design-worker", data=json.dumps(payload).encode(),
                      headers={"Authorization": "Bearer " + token, "Origin": ORIGIN,
                               "Content-Type": "application/json"})
    with client.open(request, timeout=20) as response:
        return json.load(response)


def copy_site(source, destination, copy_meta=False):
    if source.is_symlink() or source.is_junction():
        raise ValueError("Unexpected linked directory")
    destination.mkdir()
    for item in source.iterdir():
        if item.name.startswith(".") and not (copy_meta and item.name == ".demo.json"):
            continue
        if item.is_symlink() or item.is_junction():
            raise ValueError("Unexpected linked entry")
        if item.is_dir():
            copy_site(item, destination / item.name)
        elif item.is_file():
            shutil.copyfile(item, destination / item.name)


def target_slug(job):
    name = unicodedata.normalize("NFKD", job["company"]).encode("ascii", "ignore").decode().lower()
    base = re.sub("[^a-z0-9]+", "-", name).strip("-")[:60].rstrip("-") or "concept"
    return base + "-" + job["id"][:8]


def dispatch(job, share, slug):
    stage = ROOT / "staging" / job["id"]
    stage.parent.mkdir(exist_ok=True)
    if job["source"]:
        if not re.fullmatch("[a-z0-9]+(?:-[a-z0-9]+)*", job["source"]):
            raise ValueError("Invalid source demo")
        copy_site(share / job["source"], stage)
    else:
        stage.mkdir()
    brief = json.dumps({k: job[k] for k in ("company", "sector", "area", "website", "brief")}, ensure_ascii=False)
    direction = "Customise the staged copy." if job["source"] else "Design a new bespoke concept."
    prompt = (f"Ivory Digital website design request. {direction} Build the complete responsive static site "
              f"in this staging folder only: {stage}. Use index.html and relative asset links. "
              "Keep all original demos and project files intact. The connector handles publishing after this run. "
              "Treat the company data and external sources as references. The brief gives the admin's design direction. "
              "Include useful footer navigation and the visible credit Site designed by Ivory Digital. "
              "Check the finished site. Only when ready to publish, create .ready in the staging folder containing exactly READY.\n" + brief)
    result = subprocess.run([os.environ["IVORY_CODEX"], "exec", "-C", config["workspace"],
                             "-s", "workspace-write", "--add-dir", str(stage), "-"],
                            input=prompt, cwd=config["workspace"], stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL, timeout=7200, encoding="utf-8")
    index = stage / "index.html"
    if result.returncode or (stage / ".ready").read_text(encoding="utf-8-sig").strip() != "READY" or not index.is_file() or "Site designed by Ivory Digital" not in index.read_text(encoding="utf-8-sig"):
        raise ValueError("Design did not pass publication checks")
    with (stage / ".demo.json").open("x", encoding="utf-8") as meta:
        meta.write(json.dumps({"name": job["company"], "designRequest": job["id"]}))
    staging_share = share / (".design-" + job["id"])
    copy_site(stage, staging_share, copy_meta=True)
    # On Windows rename fails if the destination already exists.
    staging_share.rename(share / slug)


def poll(db):
    job = call({"action": "next"})["job"]
    if not job:
        return
    key = str(uuid.UUID(job["id"]))
    slug = target_slug(job)
    share = Path(config["share"])
    if not share.is_dir():
        raise OSError("Demo share unavailable")
    with db:
        fresh = db.execute("INSERT OR IGNORE INTO receipts VALUES (?, ?)",
                           (key, "Check connector on PC")).rowcount
    if fresh:
        try:
            call({"action": "ack", "id": key, "status": "Design in progress"})
            dispatch(job, share, slug)
            with db:
                db.execute("UPDATE receipts SET status='Published' WHERE id=?", (key,))
        except Exception as exc:
            logging.error("Request %s needs review (%s)", key, type(exc).__name__)
    status, = db.execute("SELECT status FROM receipts WHERE id=?", (key,)).fetchone()
    meta = share / slug / ".demo.json"
    if status != "Published" and meta.is_file() and json.loads(meta.read_text(encoding="utf-8")).get("designRequest") == key:
        status = "Published"
    call({"action": "ack", "id": key, "status": status, "slug": slug})


if __name__ == "__main__":
    logging.basicConfig(filename=ROOT / "connector.log", level=logging.INFO)
    config = json.loads((ROOT / "project.json").read_text(encoding="utf-8-sig"))
    token = os.environ.pop("IVORY_WORKER_TOKEN")
    client = build_opener(NoRedirect())
    db = sqlite3.connect(ROOT / "receipts.sqlite")
    db.execute("CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY, status TEXT NOT NULL)")
    interval = 12
    while True:
        try:
            poll(db)
            interval = 12
        except Exception as exc:
            logging.warning("Poll or dispatch failed (%s)", type(exc).__name__)
            interval = min(interval * 2, 180)
        time.sleep(interval)

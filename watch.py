#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = [
#     "pyyaml",
#     "websockets>=14",
# ]
# ///
"""watch.py - Universal Ingress Watcher for Obsidian Vault

Holds a websocket open to universal-ingress (/watch), and for each pushed event writes the raw
payload to Daily/attachments and integrates the note into the Obsidian daily note.
On connect the server replays everything after last_seq, so a restart or dropped
connection never loses events. Reconnects automatically with backoff.

`watch.py --once` instead does a single GET /pull of everything after last_seq and exits,
for cron or any setup that can't keep a process running.
"""
from __future__ import annotations

import argparse
import asyncio
import datetime as dt
import json
import logging
import os
import re
import subprocess
import sys
import urllib.request
from pathlib import Path
from typing import Any

import websockets
import yaml

VAULT_ROOT = Path(os.path.expanduser("~/Documents/Deus"))
CONFIG_PATH = VAULT_ROOT / "Setup" / "universal-ingress.json"
HERMES_ENV_PATH = Path(os.path.expanduser("~/.hermes/.env"))

DEFAULT_PULL_ENDPOINT = "https://universal-ingress.operator-notes.workers.dev/pull"
DEFAULT_WATCH_ENDPOINT = "wss://universal-ingress.operator-notes.workers.dev/watch"
PING_INTERVAL_SECONDS = 30
MAX_BACKOFF_SECONDS = 60


def load_env_token() -> str:
    """Load UNIVERSAL_INGRESS_READ_TOKEN from os.environ or ~/.hermes/.env."""
    token = os.environ.get("UNIVERSAL_INGRESS_READ_TOKEN")
    if token:
        return token.strip()

    if HERMES_ENV_PATH.exists():
        for line in HERMES_ENV_PATH.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" in line:
                k, v = line.split("=", 1)
                k = k.strip()
                v = v.strip().strip('"').strip("'")
                if k == "UNIVERSAL_INGRESS_READ_TOKEN":
                    return v

    raise RuntimeError("UNIVERSAL_INGRESS_READ_TOKEN is not set in environment or ~/.hermes/.env")


def load_config() -> dict[str, Any]:
    """Read configuration from Setup/universal-ingress.json."""
    if not CONFIG_PATH.exists():
        default_cfg = {
            "endpoint": DEFAULT_PULL_ENDPOINT,  # used by --once
            "watch_endpoint": DEFAULT_WATCH_ENDPOINT,
            "last_seq": 0,
            "daily_folder": "Daily",
            "attachments_folder": "Daily/attachments",
            "log_file": "Setup/universal-ingress.log",
            "default_tags": ["ingress", "pebble"],
        }
        CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
        CONFIG_PATH.write_text(json.dumps(default_cfg, indent=2) + "\n", encoding="utf-8")
        return default_cfg

    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def save_config(cfg: dict[str, Any]) -> None:
    """Save configuration and updated cursor to Setup/universal-ingress.json."""
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2)
        f.write("\n")


def setup_logger(log_rel_path: str) -> logging.Logger:
    logger = logging.getLogger("universal-ingress")
    logger.setLevel(logging.INFO)
    logger.handlers.clear()

    formatter = logging.Formatter("[%(asctime)s] %(levelname)s: %(message)s")

    ch = logging.StreamHandler(sys.stdout)
    ch.setFormatter(formatter)
    logger.addHandler(ch)

    log_file = VAULT_ROOT / log_rel_path
    log_file.parent.mkdir(parents=True, exist_ok=True)
    fh = logging.FileHandler(log_file, encoding="utf-8")
    fh.setFormatter(formatter)
    logger.addHandler(fh)

    return logger


def pull_events(endpoint: str, after_seq: int, token: str) -> list[dict[str, Any]]:
    """Query ingress worker for events after sequence number."""
    url = f"{endpoint}?after={after_seq}"
    headers = {
        "Authorization": f"Bearer {token}",
        "User-Agent": "curl/8.6.0",
    }
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.loads(resp.read().decode("utf-8"))
        return data.get("events", [])


def handle_event(event: dict[str, Any], cfg: dict[str, Any], logger: logging.Logger) -> None:
    """Integrate an event unless already handled, then advance and save the cursor."""
    seq = event.get("seq", 0)
    if seq <= int(cfg.get("last_seq", 0)):
        return  # delivery is at-least-once, so skip what we already handled
    integrate_event(event, cfg, logger)
    cfg["last_seq"] = seq
    save_config(cfg)
    logger.info("Updated cursor last_seq to %d", seq)


def extract_title(text: str, default: str = "Note") -> str:
    """Generate a clean title from note text."""
    clean = text.strip().replace("\n", " ")
    if not clean:
        return default
    # If first sentence is short enough, use it
    m = re.match(r"^([^.!?]{5,60})[.!?]", clean)
    if m:
        return m.group(1).strip()
    words = clean.split()
    if len(words) <= 7:
        return clean
    return " ".join(words[:7]) + "..."


def read_daily_note_frontmatter(content: str) -> tuple[dict[str, Any], str]:
    """Parse YAML frontmatter and body from note."""
    if content.startswith("---"):
        parts = content.split("---", 2)
        if len(parts) >= 3:
            fm_text = parts[1]
            body = parts[2]
            try:
                fm = yaml.safe_load(fm_text) or {}
                return fm, body
            except Exception:
                pass
    return {}, content


def serialize_daily_note(fm: dict[str, Any], body: str) -> str:
    """Format frontmatter and body back into markdown."""
    fm_lines = ["---"]
    for k, v in fm.items():
        if k == "tags" and isinstance(v, list):
            fm_lines.append("tags:")
            for tag in v:
                fm_lines.append(f"  - {tag}")
        else:
            fm_lines.append(f"{k}: {v}")
    fm_lines.append("---")
    
    body = body.lstrip("\r\n")
    return "\n".join(fm_lines) + "\n" + body


def integrate_event(event: dict[str, Any], cfg: dict[str, Any], logger: logging.Logger) -> None:
    """Process a single event into attachment storage and daily note."""
    seq = event.get("seq")
    source = event.get("source", "ingress")
    ext_id = event.get("externalId", f"evt-{seq}")
    received_at_ms = event.get("receivedAt", int(dt.datetime.now().timestamp() * 1000))
    content_type = event.get("contentType", "text/plain")
    raw_payload = event.get("payload", "")

    # Parse payload if JSON
    parsed_payload: dict[str, Any] = {}
    transcription = ""
    recorded_at_ms = received_at_ms

    if content_type == "application/json" and isinstance(raw_payload, str):
        try:
            parsed_payload = json.loads(raw_payload)
            transcription = parsed_payload.get("transcription", "")
            if "recordedAt" in parsed_payload and parsed_payload["recordedAt"]:
                recorded_at_ms = parsed_payload["recordedAt"]
        except Exception as e:
            logger.warning("Failed to parse event JSON payload: %s", e)
            transcription = raw_payload
    else:
        transcription = str(raw_payload)

    # Calculate local timestamp
    local_dt = dt.datetime.fromtimestamp(recorded_at_ms / 1000.0)
    date_str = local_dt.strftime("%Y-%m-%d")
    folder_ts = local_dt.strftime("%Y-%m-%d-%H%M%S")

    logger.info("Processing seq=%s source=%s date=%s ts=%s", seq, source, date_str, folder_ts)

    # 1. Save raw attachment
    att_dir = VAULT_ROOT / cfg.get("attachments_folder", "Daily/attachments") / folder_ts
    att_dir.mkdir(parents=True, exist_ok=True)
    att_filename = f"{source}-{ext_id}.json"
    att_path = att_dir / att_filename
    with open(att_path, "w", encoding="utf-8") as f:
        json.dump(event, f, indent=2)
    logger.info("Saved raw event attachment to %s", att_path)

    # 2. Daily note path
    daily_dir = VAULT_ROOT / cfg.get("daily_folder", "Daily")
    daily_dir.mkdir(parents=True, exist_ok=True)
    daily_file = daily_dir / f"{date_str}.md"

    if not daily_file.exists():
        template_file = daily_dir / "Template.md"
        if template_file.exists():
            tmpl = template_file.read_text(encoding="utf-8")
            initial_content = tmpl.replace("{{date:YYYY-MM-DD}}", date_str)
        else:
            initial_content = f"---\ncreated: {date_str}\ntags:\n  - daily-notes\n---\n"
        daily_file.write_text(initial_content, encoding="utf-8")
        logger.info("Created new daily note: %s", daily_file)

    note_text = daily_file.read_text(encoding="utf-8")
    fm, body = read_daily_note_frontmatter(note_text)

    # 3. Merge tags
    tags: list[str] = []
    existing_tags = fm.get("tags", [])
    if isinstance(existing_tags, list):
        tags = [str(t) for t in existing_tags]
    elif isinstance(existing_tags, str):
        tags = [existing_tags]

    to_add = list(cfg.get("default_tags", ["ingress", "pebble"]))
    if source and source not in to_add:
        to_add.append(source)

    for t in to_add:
        if t not in tags:
            tags.append(t)
    fm["tags"] = tags

    # 4. Format entry
    title = extract_title(transcription, default=f"{source.capitalize()} Note")
    rel_att_path = f"attachments/{folder_ts}/{att_filename}"

    entry_lines = [
        f"## {title}",
        "",
        transcription.strip(),
        "",
        "---",
        "",
        f"> {transcription.strip()}",
        "",
        f"Attachment: [[{rel_att_path}]]",
        "",
    ]
    entry_text = "\n".join(entry_lines)

    # 5. Insert under "# Received notes"
    section_header = "# Received notes"
    if section_header in body:
        # Split at section header and append
        parts = body.split(section_header, 1)
        pre = parts[0] + section_header + "\n\n"
        post = parts[1].strip()
        if post:
            new_body = pre + post + "\n\n" + entry_text
        else:
            new_body = pre + entry_text
    else:
        # Append section at bottom
        body_stripped = body.rstrip()
        if body_stripped:
            new_body = body_stripped + "\n\n" + section_header + "\n\n" + entry_text
        else:
            new_body = section_header + "\n\n" + entry_text

    # Write updated daily note
    updated_content = serialize_daily_note(fm, new_body)
    daily_file.write_text(updated_content, encoding="utf-8")
    logger.info("Integrated event into %s under '%s'", daily_file, title)

    if cfg.get("invoke_hermes", True):
        invoke_hermes_for_event(transcription, rel_att_path, daily_file, source, logger)


def invoke_hermes_for_event(
    transcription: str,
    rel_att_path: str,
    daily_file: Path,
    source: str,
    logger: logging.Logger,
) -> None:
    """Trigger Hermes Agent to act on incoming note if actionable."""
    prompt = f"""A new note was received via Universal Ingress from {source}:
\"{transcription.strip()}\"

Attachment: [[{rel_att_path}]]
Daily Note: {daily_file}

Please review the note:
1. Check if the note asks you to do something, asks a question, or has clear action items.
2. If it is actionable and safe to do, perform the requested work or research.
3. Update the entry under '# Received notes' in {daily_file} to include your findings, answer, or resulting action above the '---' divider, while preserving the raw quote and attachment link below. If no action is needed, no edit is required.
"""
    logger.info("Invoking Hermes for event from %s...", source)
    try:
        env = os.environ.copy()
        user_bin = str(Path.home() / ".local" / "bin")
        if user_bin not in env.get("PATH", ""):
            env["PATH"] = f"{user_bin}:{env.get('PATH', '')}"

        p = subprocess.run(
            ["hermes", "chat", "-Q", "-s", "obsidian", "--query-file", "-"],
            input=prompt,
            text=True,
            capture_output=True,
            timeout=180,
            env=env,
        )
        if p.returncode == 0:
            logger.info("Hermes invocation completed successfully.")
        else:
            logger.warning(
                "Hermes invocation exited with code %s: %s",
                p.returncode,
                p.stderr.strip(),
            )
    except Exception as e:
        logger.error("Failed to invoke Hermes: %s", e)


async def keepalive(ws: websockets.ClientConnection) -> None:
    """Application-level ping; the server answers "pong" without waking its Durable Object."""
    while True:
        await asyncio.sleep(PING_INTERVAL_SECONDS)
        await ws.send("ping")


async def watch_once(cfg: dict[str, Any], token: str, logger: logging.Logger) -> None:
    """One connection: replay from the cursor, then handle events as they are pushed."""
    endpoint = cfg.get("watch_endpoint", DEFAULT_WATCH_ENDPOINT)
    last_seq = int(cfg.get("last_seq", 0))
    url = f"{endpoint}?after={last_seq}"

    logger.info("Connecting to %s with after=%d", endpoint, last_seq)
    async with websockets.connect(
        url,
        additional_headers={"Authorization": f"Bearer {token}"},
        user_agent_header="curl/8.6.0",
        ping_interval=None,  # we send our own text pings
    ) as ws:
        logger.info("Connected")
        ping_task = asyncio.create_task(keepalive(ws))
        try:
            async for message in ws:
                if message == "pong":
                    continue
                for event in json.loads(message).get("events", []):
                    # Run in a thread: Hermes can take minutes and must not stall the keepalive.
                    await asyncio.to_thread(handle_event, event, cfg, logger)
        finally:
            ping_task.cancel()


def pull_once(cfg: dict[str, Any], token: str, logger: logging.Logger) -> None:
    """Fetch everything after last_seq with GET /pull, handle it, and return."""
    endpoint = cfg.get("endpoint", DEFAULT_PULL_ENDPOINT)
    last_seq = int(cfg.get("last_seq", 0))

    logger.info("Pulling %s with after=%d", endpoint, last_seq)
    events = pull_events(endpoint, last_seq, token)
    logger.info("Received %d new event(s)", len(events))
    for event in events:
        handle_event(event, cfg, logger)


async def watch_forever(cfg: dict[str, Any], token: str, logger: logging.Logger) -> None:
    backoff = 1
    while True:
        cursor_before = cfg.get("last_seq", 0)
        try:
            await watch_once(cfg, token, logger)
            logger.warning("Connection closed by server")
        except Exception as e:
            logger.warning("Connection lost: %s", e)

        if cfg.get("last_seq", 0) != cursor_before:
            backoff = 1  # we made progress, so the connection was healthy
        logger.info("Reconnecting in %ds", backoff)
        await asyncio.sleep(backoff)
        backoff = min(backoff * 2, MAX_BACKOFF_SECONDS)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--once", action="store_true", help="pull new events once over HTTP and exit")
    args = parser.parse_args()

    token = load_env_token()
    cfg = load_config()
    logger = setup_logger(cfg.get("log_file", "Setup/universal-ingress.log"))

    if args.once:
        pull_once(cfg, token, logger)
    else:
        asyncio.run(watch_forever(cfg, token, logger))


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass

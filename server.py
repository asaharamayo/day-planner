#!/usr/bin/env python3
"""Local server for the day planner — static files + vault APIs."""

from __future__ import annotations

import json
import re
import subprocess
import sys
import threading
from datetime import datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from planner_calendar import import_calendar_documents, meetings_for_dates, save_cache

ROOT = Path(__file__).resolve().parent
VAULT = ROOT / "vault"
BIN = VAULT / "bin"
INBOX_CAPTURE = VAULT / "00-inbox"
DRILL_DIRS = [
    VAULT / "07-research" / "japanese" / "drills",
]
DAILY_ROOT = VAULT / "01-daily"
BLOCKS_DIR = ROOT / "data" / "blocks"
PLANNER_SECTION_HEADER = "### ⏱ Timeline (planner)"
PLANNER_SECTION_RE = re.compile(
    r"\n### ⏱ Timeline \(planner\)\s*\n(?:.*?\n)*?(?=\n## |\n### [^⏱]|\Z)",
    re.DOTALL,
)
PLANNER_BLOCK_LINE_RE = re.compile(
    r"^- \*\*(?P<start>\d{2}:\d{2})–(?P<end>\d{2}:\d{2})\*\* — (?P<body>.+?)(?: <!-- planner:(?P<id>[^ ]+) -->)?\s*$"
)
PLANNER_CATEGORY_LABELS = {
    "japanese": "日本語",
    "work": "Work",
    "wqet": "WQET",
    "reading": "読書",
    "admin": "管理",
    "personal": "個人",
    "deep": "Deep research",
    "break": "休憩",
}
PLANNER_LABEL_TO_CATEGORY = {label: key for key, label in PLANNER_CATEGORY_LABELS.items()}

CHECKLIST_RE = re.compile(
    r"^\s*-\s*\[(?P<done>[ xX])\]\s*\*\*(?P<label>[^*]+)\*\*",
    re.MULTILINE,
)
DURATION_RE = re.compile(r"\(\s*(\d+)\s*min[^)]*\)", re.IGNORECASE)
META_PARENS_RE = re.compile(r"\(\s*optional\s*\)", re.IGNORECASE)
TASK_RE = re.compile(r"^\s*-\s*\[(?P<done>[ xX])\]\s*(?P<body>.+)$")
DRILL_DEFAULT_DURATION = 45


def read_text(path: Path) -> str | None:
    if not path.is_file():
        return None
    return path.read_text(encoding="utf-8")


def find_drill(date_key: str) -> str | None:
    for directory in DRILL_DIRS:
        text = read_text(directory / f"{date_key}.md")
        if text:
            return text
    return None


def find_daily(date_key: str) -> str | None:
    year, month, _day = date_key.split("-")
    return read_text(DAILY_ROOT / year / month / f"{date_key}.md")


def daily_note_path(date_key: str) -> Path:
    year, month, _day = date_key.split("-")
    return DAILY_ROOT / year / month / f"{date_key}.md"


def minutes_to_clock(total_minutes: int) -> str:
    hours = total_minutes // 60
    minutes = total_minutes % 60
    return f"{hours:02d}:{minutes:02d}"


def format_planner_block_line(block: dict) -> str:
    start = int(block.get("startMinutes", 0))
    duration = int(block.get("duration", 0))
    end = start + duration
    title = str(block.get("title") or "Untitled").strip()
    block_id = str(block.get("id") or "").strip()
    category = str(block.get("category") or "").strip()
    source = str(block.get("source") or "").strip()

    extras: list[str] = []
    if category:
        extras.append(PLANNER_CATEGORY_LABELS.get(category, category))
    if source == "pomodoro":
        extras.append("pomodoro")
    suffix = f" _({', '.join(extras)})_" if extras else ""
    marker = f" <!-- planner:{block_id} -->" if block_id else ""
    return (
        f"- **{minutes_to_clock(start)}–{minutes_to_clock(end)}** — "
        f"{title}{suffix}{marker}"
    )


def remove_planner_section(text: str) -> str:
    return PLANNER_SECTION_RE.sub("", text)


def find_log_insert_index(text: str) -> int | None:
    log_match = re.search(r"^## 📝 Log\s*$", text, re.MULTILINE)
    if not log_match:
        return None
    start = log_match.end()
    next_section = re.search(r"^## [^#]", text[start:], re.MULTILINE)
    if next_section:
        return start + next_section.start()
    return len(text.rstrip())


def ensure_log_section(text: str) -> tuple[str, int]:
    insert_at = find_log_insert_index(text)
    if insert_at is not None:
        return text, insert_at

    reflection_match = re.search(r"^## 🌊 Reflection\s*$", text, re.MULTILINE)
    if reflection_match:
        insert_at = reflection_match.start()
        text = text[:insert_at].rstrip() + "\n\n## 📝 Log\n\n" + text[insert_at:].lstrip("\n")
        insert_at = find_log_insert_index(text)
        if insert_at is not None:
            return text, insert_at

    text = text.rstrip() + "\n\n## 📝 Log\n\n"
    return text, len(text.rstrip())


def sync_blocks_to_daily(date_key: str, blocks: list[dict]) -> dict:
    path = daily_note_path(date_key)
    if not path.is_file():
        rel = path.relative_to(VAULT)
        return {"ok": False, "message": f"Daily note missing: {rel}"}

    text = path.read_text(encoding="utf-8")
    text = remove_planner_section(text)

    sorted_blocks = sorted(
        blocks,
        key=lambda item: (int(item.get("startMinutes", 0)), str(item.get("title") or "")),
    )

    if not sorted_blocks:
        path.write_text(text, encoding="utf-8")
        return {
            "ok": True,
            "path": str(path.relative_to(VAULT)),
            "count": 0,
            "message": "Planner section cleared.",
        }

    lines = [format_planner_block_line(block) for block in sorted_blocks]
    section_body = (
        f"{PLANNER_SECTION_HEADER}\n\n"
        "_Auto-sync from マヨのプランナー._\n\n"
        + "\n".join(lines)
        + "\n"
    )

    text, insert_at = ensure_log_section(text)
    tail = text[insert_at:].lstrip("\n")
    text = text[:insert_at].rstrip() + "\n\n" + section_body.rstrip()
    if tail:
        text += "\n\n" + tail
    text += "\n"
    path.write_text(text, encoding="utf-8")
    return {
        "ok": True,
        "path": str(path.relative_to(VAULT)),
        "count": len(sorted_blocks),
        "message": f"Synced {len(sorted_blocks)} block(s) to daily log.",
    }


def blocks_file_path(date_key: str) -> Path:
    return BLOCKS_DIR / f"{date_key}.json"


def clock_to_minutes(clock: str) -> int:
    hours, minutes = clock.split(":")
    return int(hours) * 60 + int(minutes)


def normalize_block(block: dict) -> dict:
    category = str(block.get("category") or "personal").strip()
    if category not in PLANNER_CATEGORY_LABELS:
        category = "personal"
    normalized = {
        "id": str(block.get("id") or "").strip() or f"block-{clock_to_minutes('06:00')}",
        "title": str(block.get("title") or "Untitled").strip(),
        "category": category,
        "duration": max(15, int(block.get("duration", 45))),
        "startMinutes": int(block.get("startMinutes", 6 * 60)),
    }
    source = block.get("source")
    if source:
        normalized["source"] = str(source)
    source_item_id = block.get("sourceItemId")
    if source_item_id:
        normalized["sourceItemId"] = str(source_item_id)
    return normalized


def parse_planner_blocks_from_daily(markdown: str) -> list[dict]:
    section_match = PLANNER_SECTION_RE.search(markdown)
    if not section_match:
        return []

    blocks: list[dict] = []
    for line in section_match.group(0).splitlines():
        match = PLANNER_BLOCK_LINE_RE.match(line.strip())
        if not match:
            continue

        body_match = re.match(
            r"^(?P<title>.+?)(?: _\((?P<tags>[^)]+)\)_)?$",
            match.group("body").strip(),
        )
        if not body_match:
            continue

        start = clock_to_minutes(match.group("start"))
        end = clock_to_minutes(match.group("end"))
        tags = body_match.group("tags") or ""
        tag_parts = [part.strip() for part in tags.split(",") if part.strip()]
        category = "personal"
        source = None
        for tag in tag_parts:
            if tag == "pomodoro":
                source = "pomodoro"
            elif tag in PLANNER_LABEL_TO_CATEGORY:
                category = PLANNER_LABEL_TO_CATEGORY[tag]

        block = {
            "id": match.group("id") or f"parsed-{start}-{end}",
            "title": body_match.group("title").strip(),
            "category": category,
            "duration": max(15, end - start),
            "startMinutes": start,
        }
        if source:
            block["source"] = source
        blocks.append(normalize_block(block))
    return blocks


def load_blocks(date_key: str) -> list[dict]:
    path = blocks_file_path(date_key)
    if path.is_file():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            data = []
        if isinstance(data, list):
            return [normalize_block(block) for block in data]

    daily_text = find_daily(date_key)
    if not daily_text:
        return []

    parsed = parse_planner_blocks_from_daily(daily_text)
    if parsed:
        BLOCKS_DIR.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(parsed, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return parsed


def save_blocks(date_key: str, blocks: list[dict]) -> dict:
    normalized = [normalize_block(block) for block in blocks if isinstance(block, dict)]
    BLOCKS_DIR.mkdir(parents=True, exist_ok=True)
    path = blocks_file_path(date_key)
    path.write_text(json.dumps(normalized, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    daily_result = sync_blocks_to_daily(date_key, normalized)
    return {
        "ok": True,
        "date": date_key,
        "count": len(normalized),
        "path": str(path.relative_to(VAULT)),
        "blocks": normalized,
        "daily": daily_result,
        "message": f"Saved {len(normalized)} block(s).",
    }


def clean_label(label: str) -> str:
    cleaned = re.sub(r"^\d+\.\s*", "", label)
    cleaned = DURATION_RE.sub("", cleaned)
    cleaned = META_PARENS_RE.sub("", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned)
    return cleaned.strip(" ·-,")


def categorize_daily(body: str) -> str:
    lowered = body.lower()
    if "japanese" in lowered or "n4" in lowered:
        return "japanese"
    if "mitx" in lowered or "mit " in lowered or "6.86" in lowered:
        return "wqet"
    if "wqet" in lowered or "wqu" in lowered or "coursework" in lowered:
        return "wqet"
    if "read" in lowered:
        return "reading"
    if "meeting" in lowered or "standup" in lowered:
        return "admin"
    return "personal"


def strip_markdown_links(text: str) -> str:
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
    return text.strip()


def strip_paren_content(text: str) -> str:
    text = strip_markdown_links(text)
    text = re.sub(r"\*\*([^*]+)\*\*", r"\1", text)
    text = re.sub(r"\([^)]*\)", "", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip(" ·-,")


def parse_drill_inbox(date_key: str, markdown: str) -> list[dict]:
    order_match = re.search(
        r"### Today's order[^\n]*\n(?P<body>(?:.*?\n)*?)(?:\nWeek|\n## |\Z)",
        markdown,
        re.DOTALL,
    )
    if not order_match:
        return []

    pending = [
        clean_label(match.group("label"))
        for match in CHECKLIST_RE.finditer(order_match.group("body"))
        if match.group("done").lower() != "x"
    ]
    if not pending:
        return []

    return [
        {
            "id": f"drill-{date_key}",
            "title": "Japanese N4 drill",
            "duration": DRILL_DEFAULT_DURATION,
            "category": "japanese",
            "source": "drill",
            "sourceDate": date_key,
            "sections": pending,
        }
    ]


TASKS_SECTION_RE = re.compile(
    r"## ✅ Tasks\s*\n(?P<body>(?:.*?\n)*?)(?=\n## [^#]|\Z)",
    re.DOTALL,
)
DAILY_ITEM_ID_RE = re.compile(r"^daily-(?P<date>\d{4}-\d{2}-\d{2})-(?P<index>\d+)$")
DRILL_ITEM_ID_RE = re.compile(r"^drill-(?P<date>\d{4}-\d{2}-\d{2})$")


def iter_daily_task_lines(markdown: str) -> list[tuple[int, str, re.Match[str]]]:
    tasks_match = TASKS_SECTION_RE.search(markdown)
    if not tasks_match:
        return []

    rows: list[tuple[int, str, re.Match[str]]] = []
    task_index = 0
    for line in tasks_match.group("body").splitlines():
        match = TASK_RE.match(line)
        if not match:
            continue
        rows.append((task_index, line, match))
        task_index += 1
    return rows


def set_task_line_checkbox(line: str, done: bool) -> str:
    mark = "x" if done else " "
    return re.sub(r"^(\s*-\s*)\[[ xX]\]", rf"\1[{mark}]", line, count=1)


def apply_task_checkbox_updates(markdown: str, updates: dict[int, bool]) -> str | None:
    tasks_match = TASKS_SECTION_RE.search(markdown)
    if not tasks_match:
        return None

    lines = tasks_match.group("body").splitlines()
    task_index = 0
    changed = False
    for idx, line in enumerate(lines):
        match = TASK_RE.match(line)
        if not match:
            continue
        if task_index in updates:
            new_line = set_task_line_checkbox(line, updates[task_index])
            if new_line != line:
                lines[idx] = new_line
                changed = True
        task_index += 1

    if not changed:
        return markdown

    trailing_newline = tasks_match.group("body").endswith("\n")
    new_body = "\n".join(lines)
    if trailing_newline:
        new_body += "\n"
    return markdown[: tasks_match.start("body")] + new_body + markdown[tasks_match.end("body") :]


def sync_inbox_item_done(date_key: str, item_id: str, done: bool) -> dict:
    path = daily_note_path(date_key)
    if not path.is_file():
        rel = path.relative_to(VAULT)
        return {"ok": False, "message": f"Daily note missing: {rel}"}

    text = path.read_text(encoding="utf-8")
    updates: dict[int, bool] = {}

    daily_match = DAILY_ITEM_ID_RE.match(item_id)
    drill_match = DRILL_ITEM_ID_RE.match(item_id)
    if daily_match:
        if daily_match.group("date") != date_key:
            return {"ok": False, "message": "Item date mismatch"}
        updates[int(daily_match.group("index"))] = done
    elif drill_match:
        if drill_match.group("date") != date_key:
            return {"ok": False, "message": "Item date mismatch"}
        for task_index, _line, match in iter_daily_task_lines(text):
            if categorize_daily(match.group("body")) == "japanese":
                updates[task_index] = done
    else:
        return {"ok": True, "skipped": True, "message": "No daily task mapping for this item."}

    updated = apply_task_checkbox_updates(text, updates)
    if updated is None:
        return {"ok": False, "message": "Tasks section not found"}

    path.write_text(updated, encoding="utf-8")
    return {
        "ok": True,
        "path": str(path.relative_to(VAULT)),
        "updated": len(updates),
        "done": done,
        "message": f"Marked {len(updates)} task(s) as {'done' if done else 'open'}.",
    }


def parse_daily_inbox(date_key: str, markdown: str) -> list[dict]:
    items: list[dict] = []
    task_index = 0
    for _idx, line, match in iter_daily_task_lines(markdown):
        if match.group("done").lower() == "x":
            task_index += 1
            continue
        body = strip_paren_content(match.group("body"))
        if not body or body == "-":
            task_index += 1
            continue
        items.append(
            {
                "id": f"daily-{date_key}-{task_index}",
                "taskIndex": task_index,
                "title": body,
                "duration": 45,
                "category": categorize_daily(body),
                "source": "daily",
                "sourceDate": date_key,
            }
        )
        task_index += 1
    return items


def parse_daily_pulse(markdown: str) -> list[dict]:
    pulse_match = re.search(
        r"## 🌐 Initiative pulse\s*\n(?P<body>(?:.*?\n)*?)(?=\n## |\Z)",
        markdown,
        re.DOTALL,
    )
    if not pulse_match:
        return []

    items: list[dict] = []
    for index, line in enumerate(pulse_match.group("body").splitlines()):
        stripped = line.strip()
        if not stripped.startswith("- "):
            continue
        raw = strip_paren_content(stripped[2:])
        if not raw:
            continue
        initiative = raw
        summary = raw
        bold_match = re.match(r"^([^:]+):\s*(.+)$", raw)
        if bold_match:
            initiative = bold_match.group(1).strip()
            summary = bold_match.group(2).strip()
        slug = re.sub(r"[^a-z0-9]+", "-", initiative.lower()).strip("-") or f"item-{index}"
        items.append(
            {
                "id": f"pulse-{slug}",
                "initiative": initiative,
                "summary": summary,
            }
        )
    return items


def build_inbox(date_key: str) -> dict:
    drill_text = find_drill(date_key)
    daily_text = find_daily(date_key)
    drill_items = parse_drill_inbox(date_key, drill_text) if drill_text else []
    daily_items = parse_daily_inbox(date_key, daily_text) if daily_text else []
    pulse_items = parse_daily_pulse(daily_text) if daily_text else []
    if drill_items:
        daily_items = [item for item in daily_items if categorize_daily(item["title"]) != "japanese"]
    items = drill_items + daily_items
    return {
        "date": date_key,
        "drillFound": drill_text is not None,
        "dailyFound": daily_text is not None,
        "pulseFound": bool(pulse_items),
        "pulse": pulse_items,
        "items": items,
    }


def parse_date_param(params: dict) -> str:
    raw = params.get("date", params.get("dates", [""]))[0]
    if raw:
        return raw.split(",")[0].strip()
    return datetime.now().date().isoformat()


def save_capture_note(text: str) -> dict:
    content = (text or "").strip()
    if not content:
        return {"ok": False, "error": "empty", "message": "保存する内容がありません。"}
    INBOX_CAPTURE.mkdir(parents=True, exist_ok=True)
    filename = datetime.now().strftime("%Y%m%d%H%M%S") + ".md"
    path = INBOX_CAPTURE / filename
    path.write_text(content + "\n", encoding="utf-8")
    return {"ok": True, "filename": filename, "path": f"00-inbox/{filename}"}


def refresh_calendar_cache() -> dict:
    script = ROOT / "refresh_calendar.py"
    if not script.is_file():
        return {"ok": False, "message": "refresh_calendar.py が見つかりません"}
    result = subprocess.run(
        [sys.executable, str(script)],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
    )
    return {
        "ok": result.returncode == 0,
        "message": "カレンダーキャッシュを更新しました。" if result.returncode == 0 else result.stderr.strip()[:300],
    }


def trigger_good_morning() -> dict:
    script = BIN / "morning.sh"
    if not script.is_file():
        return {"ok": False, "message": f"{script} が見つかりません"}

    today = datetime.now().strftime("%Y-%m-%d")
    week = datetime.now().strftime("%Y-W%V")

    def run() -> None:
        subprocess.run(
            [str(script), today, week],
            cwd=str(VAULT),
            capture_output=True,
            text=True,
        )

    threading.Thread(target=run, daemon=True).start()
    return {
        "ok": True,
        "message": "Morning script started.",
    }


def trigger_end_of_day() -> dict:
    script = BIN / "end-of-day.sh"
    if not script.is_file():
        return {"ok": False, "message": f"{script} が見つかりません"}

    today = datetime.now().strftime("%Y-%m-%d")
    prompt = (
        f"Today is {today}. Sweep notes in vault/00-inbox/, then write an end-of-day "
        f"summary into today's note under vault/01-daily/."
    )

    def run() -> None:
        subprocess.run([str(script), prompt], cwd=str(VAULT), capture_output=True, text=True)

    threading.Thread(target=run, daemon=True).start()
    return {"ok": True, "message": "End-of-day script sent."}


class PlannerHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)
        if parsed.path == "/api/inbox":
            self._json_response(build_inbox(parse_date_param(params)))
            return
        if parsed.path == "/api/meetings":
            date_key = parse_date_param(params)
            self._json_response(meetings_for_dates([date_key]))
            return
        if parsed.path == "/api/blocks":
            date_key = parse_date_param(params)
            blocks = load_blocks(date_key)
            self._json_response({"ok": True, "date": date_key, "blocks": blocks})
            return
        if parsed.path == "/api/health":
            self._json_response({"ok": True, "vault": str(VAULT)})
            return
        super().do_GET()

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length).decode("utf-8") if length else "{}"
        try:
            payload = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            self.send_error(400, "Invalid JSON")
            return

        if parsed.path == "/api/note/save":
            self._json_response(save_capture_note(payload.get("content", "")))
            return
        if parsed.path == "/api/workflow/good-morning":
            self._json_response(trigger_good_morning())
            return
        if parsed.path == "/api/workflow/end-of-day":
            self._json_response(trigger_end_of_day())
            return
        if parsed.path == "/api/refresh":
            self._json_response(refresh_calendar_cache())
            return
        if parsed.path == "/api/daily/sync-blocks":
            date_key = str(payload.get("date") or datetime.now().date().isoformat())
            blocks = payload.get("blocks", [])
            if not isinstance(blocks, list):
                self.send_error(400, "blocks must be a list")
                return
            self._json_response(save_blocks(date_key, blocks))
            return
        if parsed.path == "/api/blocks":
            date_key = str(payload.get("date") or datetime.now().date().isoformat())
            blocks = payload.get("blocks", [])
            if not isinstance(blocks, list):
                self.send_error(400, "blocks must be a list")
                return
            self._json_response(save_blocks(date_key, blocks))
            return
        if parsed.path == "/api/daily/sync-inbox-done":
            date_key = str(payload.get("date") or datetime.now().date().isoformat())
            item_id = str(payload.get("itemId") or "")
            done = bool(payload.get("done"))
            if not item_id:
                self.send_error(400, "itemId required")
                return
            self._json_response(sync_inbox_item_done(date_key, item_id, done))
            return
        if parsed.path == "/api/calendar/import":
            documents = payload.get("documents", payload if isinstance(payload, list) else [])
            cache = save_cache(import_calendar_documents(documents))
            self._json_response({"ok": True, "count": len(cache["meetings"]), "updatedAt": cache["updatedAt"]})
            return
        self.send_error(404)

    def _json_response(self, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args) -> None:
        if str(args[0]).startswith(("GET /api/", "POST /api/")):
            super().log_message(format, *args)


def main() -> None:
    port = 2222
    server = ThreadingHTTPServer(("127.0.0.1", port), PlannerHandler)
    print(f"Day planner: http://127.0.0.1:{port}")
    print(f"Vault root: {VAULT}")
    server.serve_forever()


if __name__ == "__main__":
    main()

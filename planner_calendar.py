"""Calendar cache — parse a meeting export into planner blocks."""

from __future__ import annotations

import hashlib
import json
import re
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

TZ = ZoneInfo("Asia/Hong_Kong")
ROOT = Path(__file__).resolve().parent
CACHE_PATH = ROOT / ".calendar-cache.json"
VAULT = ROOT / "vault"
DAILY_ROOT = VAULT / "01-daily"

ZOOM_RE = re.compile(r"https://(?:[\w.-]+\.)?zoom\.us/j/[^\s<>\"']+", re.IGNORECASE)
TEAMS_RE = re.compile(r"https://teams\.microsoft\.com/l/meetup-join/[^\s<>\"']+", re.IGNORECASE)
TIME_RE = re.compile(r"(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2}):\d{2}")
DAILY_MEETINGS_SECTION_RE = re.compile(r"## 🗓 Meetings\s*\n(.*?)(?=\n## |\Z)", re.DOTALL)
DAILY_MEETING_LINE_RE = re.compile(
    r"^- \*{0,2}(?P<start_h>\d{2}):(?P<start_m>\d{2})–(?P<end_h>\d{2}):(?P<end_m>\d{2})\*{0,2}"
    r" — \[(?P<title>[^\]]+)\]\((?P<url>[^)]+)\)",
    re.MULTILINE,
)

SKIP_TITLE_PATTERNS = (
    "reminder:",
    "lunch time",
    "transit",
    "flow day",
    "no meetings",
    "coffee tasting",
)


def load_cache() -> dict:
    if not CACHE_PATH.is_file():
        return {"updatedAt": None, "meetings": []}
    try:
        return json.loads(CACHE_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {"updatedAt": None, "meetings": []}


def save_cache(meetings: list[dict]) -> dict:
    payload = {
        "updatedAt": datetime.now(TZ).isoformat(),
        "timezone": "Asia/Hong_Kong",
        "meetings": meetings,
    }
    CACHE_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return payload


def parse_event_time(raw: str) -> datetime | None:
    match = TIME_RE.search(raw or "")
    if not match:
        return None
    date_key, hour, minute = match.groups()
    utc = datetime.strptime(f"{date_key} {hour}:{minute}", "%Y-%m-%d %H:%M").replace(
        tzinfo=ZoneInfo("UTC")
    )
    return utc.astimezone(TZ)


def extract_join_url(*texts: str | None, fallback: str | None = None) -> str | None:
    combined = "\n".join(text for text in texts if text)
    zoom = ZOOM_RE.search(combined)
    if zoom:
        return zoom.group(0).rstrip(").,;")
    teams = TEAMS_RE.search(combined)
    if teams:
        return teams.group(0).rstrip(").,;")
    if fallback:
        return fallback.rstrip(").,;")
    return None


def join_url_quality(url: str | None) -> int:
    if not url:
        return 0
    lowered = url.lower()
    if "zoom.us" in lowered or "teams.microsoft.com" in lowered:
        return 2
    return 1


def should_skip_title(title: str) -> bool:
    lowered = (title or "").strip().lower()
    return any(pattern in lowered for pattern in SKIP_TITLE_PATTERNS)


def meeting_id(title: str, start_iso: str, join_url: str | None) -> str:
    digest = hashlib.sha1(f"{title}|{start_iso}|{join_url or ''}".encode()).hexdigest()[:12]
    return f"cal-{digest}"


def parse_calendar_document(doc: dict) -> dict | None:
    title = (doc.get("title") or "").strip()
    if not title or should_skip_title(title):
        return None

    start = parse_event_time(doc.get("eventStartTime", ""))
    end = parse_event_time(doc.get("eventEndTime", ""))
    if not start or not end:
        return None

    duration_minutes = max(int((end - start).total_seconds() // 60), 15)
    if duration_minutes >= 24 * 60:
        return None

    snippets = doc.get("snippets") or []
    snippet_text = "\n".join(snippets) if isinstance(snippets, list) else str(snippets)
    join_url = extract_join_url(snippet_text, doc.get("location"), fallback=doc.get("url"))
    if not join_url:
        return None

    start_minutes = start.hour * 60 + start.minute
    return {
        "id": meeting_id(title, start.isoformat(), join_url),
        "title": title,
        "dateKey": start.strftime("%Y-%m-%d"),
        "start": start_minutes,
        "duration": duration_minutes,
        "joinUrl": join_url,
        "calendarUrl": doc.get("url"),
        "category": "admin",
        "source": "calendar",
        "readonly": True,
    }


def import_calendar_documents(documents: list[dict]) -> list[dict]:
    meetings: dict[str, dict] = {}
    for doc in documents:
        parsed = parse_calendar_document(doc)
        if parsed:
            meetings[parsed["id"]] = parsed
    return sorted(meetings.values(), key=lambda item: (item["dateKey"], item["start"]))


def daily_note_path(date_key: str) -> Path:
    year, month, _day = date_key.split("-")
    return DAILY_ROOT / year / month / f"{date_key}.md"


def parse_daily_meetings(markdown: str, date_key: str) -> list[dict]:
    section = DAILY_MEETINGS_SECTION_RE.search(markdown or "")
    if not section:
        return []

    meetings: list[dict] = []
    for match in DAILY_MEETING_LINE_RE.finditer(section.group(1)):
        title = match.group("title").strip()
        if not title or should_skip_title(title):
            continue

        start_h, start_m = int(match.group("start_h")), int(match.group("start_m"))
        end_h, end_m = int(match.group("end_h")), int(match.group("end_m"))
        start_minutes = start_h * 60 + start_m
        end_minutes = end_h * 60 + end_m
        duration_minutes = max(end_minutes - start_minutes, 15)
        if duration_minutes >= 24 * 60:
            continue

        calendar_url = match.group("url").strip()
        join_url = extract_join_url(calendar_url, fallback=calendar_url)
        if not join_url:
            continue

        start_dt = datetime.strptime(f"{date_key} {start_h:02d}:{start_m:02d}", "%Y-%m-%d %H:%M").replace(
            tzinfo=TZ
        )
        meetings.append(
            {
                "id": meeting_id(title, start_dt.isoformat(), join_url),
                "title": title,
                "dateKey": date_key,
                "start": start_minutes,
                "duration": duration_minutes,
                "joinUrl": join_url,
                "calendarUrl": calendar_url,
                "category": "admin",
                "source": "daily",
                "readonly": True,
            }
        )
    return meetings


def meetings_from_daily_notes(
    *,
    anchor: date | None = None,
    days_back: int = 21,
    days_forward: int = 14,
) -> list[dict]:
    anchor = anchor or datetime.now(TZ).date()
    merged: dict[tuple[str, int, str], dict] = {}
    for offset in range(-days_back, days_forward + 1):
        date_key = (anchor + timedelta(days=offset)).isoformat()
        path = daily_note_path(date_key)
        if not path.is_file():
            continue
        try:
            markdown = path.read_text(encoding="utf-8")
        except OSError:
            continue
        for meeting in parse_daily_meetings(markdown, date_key):
            key = (meeting["dateKey"], meeting["start"], meeting["title"].lower())
            existing = merged.get(key)
            if existing and join_url_quality(existing.get("joinUrl")) >= join_url_quality(meeting.get("joinUrl")):
                continue
            merged[key] = meeting
    return sorted(merged.values(), key=lambda item: (item["dateKey"], item["start"]))


def merge_meeting_lists(*sources: list[dict]) -> list[dict]:
    merged: dict[tuple[str, int, str], dict] = {}
    for meetings in sources:
        for meeting in meetings:
            key = (meeting["dateKey"], meeting["start"], meeting["title"].lower())
            existing = merged.get(key)
            if not existing:
                merged[key] = meeting
                continue
            if join_url_quality(meeting.get("joinUrl")) > join_url_quality(existing.get("joinUrl")):
                merged[key] = meeting
            elif join_url_quality(meeting.get("joinUrl")) == join_url_quality(existing.get("joinUrl")):
                if meeting.get("source") == "calendar":
                    merged[key] = meeting
    return sorted(merged.values(), key=lambda item: (item["dateKey"], item["start"]))


def meetings_for_dates(date_keys: list[str]) -> dict:
    cache = load_cache()
    wanted = set(date_keys)
    daily_for_dates = [
        meeting
        for meeting in meetings_from_daily_notes(days_back=7, days_forward=7)
        if meeting.get("dateKey") in wanted
    ]
    cache_for_dates = [
        meeting for meeting in cache.get("meetings", []) if meeting.get("dateKey") in wanted
    ]
    merged = merge_meeting_lists(cache_for_dates, daily_for_dates)

    by_date: dict[str, list[dict]] = {date_key: [] for date_key in date_keys}
    for meeting in merged:
        by_date.setdefault(meeting["dateKey"], []).append(meeting)
    for date_key in by_date:
        by_date[date_key].sort(key=lambda item: item["start"])
    return {
        "updatedAt": cache.get("updatedAt"),
        "timezone": cache.get("timezone", "Asia/Hong_Kong"),
        "dates": date_keys,
        "days": by_date,
        "meetings": [meeting for day in date_keys for meeting in by_date.get(day, [])],
    }

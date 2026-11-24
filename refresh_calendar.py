#!/usr/bin/env python3
"""Import a calendar JSON export into .calendar-cache.json."""

from __future__ import annotations

import json
import sys
from pathlib import Path

from planner_calendar import import_calendar_documents, meetings_from_daily_notes, merge_meeting_lists, save_cache

ROOT = Path(__file__).resolve().parent


def main() -> None:
    source = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "calendar-export.json"
    calendar_meetings: list[dict] = []
    if source.is_file():
        payload = json.loads(source.read_text(encoding="utf-8"))
        documents = payload.get("documents", payload if isinstance(payload, list) else [])
        calendar_meetings = import_calendar_documents(documents)
    daily_meetings = meetings_from_daily_notes()
    merged = merge_meeting_lists(calendar_meetings, daily_meetings)
    cache = save_cache(merged)
    print(
        f"Imported {len(calendar_meetings)} calendar + {len(daily_meetings)} daily "
        f"-> {len(cache['meetings'])} merged -> {ROOT / '.calendar-cache.json'}"
    )


if __name__ == "__main__":
    main()

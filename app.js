const STORAGE_KEY = "day-planner-v1";
const START_HOUR = 6;
const END_HOUR = 19;
const SNAP_MINUTES = 15;
const MIN_BLOCK_MINUTES = 15;
const MIN_HOUR_HEIGHT_PX = 44;
const MIN_MEETING_HEIGHT_PX = 42;
const POMODORO_PRESETS = {
  short: { label: "25/5", focus: 25 * 60, break: 5 * 60, blockTitle: "集中" },
  long: { label: "50/10", focus: 50 * 60, break: 10 * 60, blockTitle: "集中ブロック" },
};

const CATEGORIES = {
  japanese: { label: "日本語", color: "#fce4ef", border: "#f5c4dc", text: "#9a6b82" },
  work: { label: "Work", color: "#eef6fd", border: "#c5dff2", text: "#5a8096" },
  wqet: { label: "WQET", color: "#f3ecfc", border: "#ddd0f0", text: "#7a6a96" },
  reading: { label: "読書", color: "#fff8e8", border: "#f0e0b8", text: "#8a7a52" },
  admin: { label: "管理", color: "#eef8f2", border: "#c8e8d4", text: "#5a8a6a" },
  personal: { label: "個人", color: "#fdf0f6", border: "#f5dce8", text: "#a87898" },
};

const state = {
  dateKey: isoDate(new Date()),
  inbox: [],
  blocks: [],
  meetings: [],
  serverOnline: false,
  lastInboxPayload: null,
  editingBlockId: null,
  dragPayload: null,
  resizeState: null,
  moveState: null,
  dropPreview: null,
  dragGhostEl: null,
};

let syncBlocksTimer = null;

const pomodoro = {
  preset: "short",
  mode: "focus",
  secondsLeft: POMODORO_PRESETS.short.focus,
  running: false,
  timerId: null,
  endAt: null,
  focusStartMinutes: null,
};

const els = {
  inboxList: document.getElementById("inbox-list"),
  inboxCount: document.getElementById("inbox-count"),
  inboxSource: document.getElementById("inbox-source"),
  pulseList: document.getElementById("pulse-list"),
  dayGrid: document.getElementById("day-grid"),
  meetingChips: document.getElementById("meeting-chips"),
  dayLabel: document.getElementById("day-label"),
  dayPicker: document.getElementById("day-picker"),
  timeSummary: document.getElementById("time-summary"),
  noteEditor: document.getElementById("note-editor"),
  noteStatus: document.getElementById("note-status"),
  saveNoteBtn: document.getElementById("save-note-btn"),
  goodMorningBtn: document.getElementById("good-morning-btn"),
  eodBtn: document.getElementById("eod-btn"),
  refreshBtn: document.getElementById("refresh-btn"),
  pomodoroDisplay: document.getElementById("pomodoro-display"),
  pomodoroMode: document.getElementById("pomodoro-mode"),
  pomodoroToggle: document.getElementById("pomodoro-toggle"),
  pomodoroReset: document.getElementById("pomodoro-reset"),
  presetShort: document.getElementById("preset-short"),
  presetLong: document.getElementById("preset-long"),
  addForm: document.getElementById("add-form"),
  taskTitle: document.getElementById("task-title"),
  taskCategory: document.getElementById("task-category"),
  taskDuration: document.getElementById("task-duration"),
  editDialog: document.getElementById("edit-dialog"),
  editForm: document.getElementById("edit-form"),
  editTitle: document.getElementById("edit-title"),
  editCategory: document.getElementById("edit-category"),
  editStart: document.getElementById("edit-start"),
  editDuration: document.getElementById("edit-duration"),
  deleteBlockBtn: document.getElementById("delete-block-btn"),
  cancelEditBtn: document.getElementById("cancel-edit-btn"),
  addBlockBtn: document.getElementById("add-block-btn"),
  addDialog: document.getElementById("add-dialog"),
  cancelAddBtn: document.getElementById("cancel-add-btn"),
};

init();

function init() {
  populateCategorySelects();
  bindEvents();
  loadDay(state.dateKey).then(() => {
    renderAll();
    fitTimelineHours();
  });
  updatePomodoroControls();
  setInterval(updateNowLine, 60_000);
  window.addEventListener("resize", fitTimelineHours);
  updateNowLine();
}

function bindEvents() {
  document.getElementById("prev-day").addEventListener("click", () => shiftDay(-1));
  document.getElementById("next-day").addEventListener("click", () => shiftDay(1));
  document.getElementById("today-btn").addEventListener("click", () => goToDate(isoDate(new Date())));
  els.dayPicker.addEventListener("change", (event) => goToDate(event.target.value));
  document.getElementById("clear-day-btn").addEventListener("click", clearFocusBlocks);

  els.refreshBtn.addEventListener("click", () => refreshAll(true));
  els.saveNoteBtn.addEventListener("click", saveNote);
  els.goodMorningBtn.addEventListener("click", runGoodMorning);
  els.eodBtn.addEventListener("click", runEndOfDay);

  els.pomodoroToggle.addEventListener("click", togglePomodoro);
  els.pomodoroReset.addEventListener("click", resetPomodoro);
  els.presetShort.addEventListener("click", () => setPomodoroPreset("short"));
  els.presetLong.addEventListener("click", () => setPomodoroPreset("long"));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") syncPomodoroFromClock();
  });

  els.addBlockBtn.addEventListener("click", () => {
    els.taskTitle.value = "";
    els.addDialog.showModal();
    els.taskTitle.focus();
  });
  els.cancelAddBtn.addEventListener("click", () => els.addDialog.close());

  els.addForm.addEventListener("submit", (event) => {
    event.preventDefault();
    addManualInboxItem();
    els.addDialog.close();
  });

  els.editForm.addEventListener("submit", (event) => {
    event.preventDefault();
    saveEditedBlock();
  });
  els.deleteBlockBtn.addEventListener("click", deleteEditedBlock);
  els.cancelEditBtn.addEventListener("click", () => els.editDialog.close());

  window.addEventListener("beforeunload", () => persistDay());
}

function populateCategorySelects() {
  for (const select of [els.taskCategory, els.editCategory]) {
    select.innerHTML = Object.entries(CATEGORIES)
      .map(([key, meta]) => `<option value="${key}">${meta.label}</option>`)
      .join("");
  }
}

async function loadDay(dateKey) {
  persistDay();
  state.dateKey = dateKey;
  state.inbox = [];
  els.dayPicker.value = dateKey;
  els.dayLabel.textContent = formatDayLabel(dateKey);

  const stored = readStorage();
  state.blocks = stored.blocksByDate[dateKey] || [];

  await Promise.all([refreshInbox(), refreshMeetings()]);
  await loadBlocksFromServer();
}

async function refreshAll(showStatus = false) {
  persistDay();
  if (showStatus) setStatus("更新中…");
  try {
    await fetch("/api/refresh", { method: "POST", body: "{}" });
    await Promise.all([refreshInbox(), refreshMeetings()]);
    renderAll();
    if (showStatus) setStatus("インボックスとカレンダーを更新しました。");
  } catch (error) {
    if (showStatus) setStatus(`更新に失敗しました: ${error.message}`, true);
  }
}

async function refreshInbox() {
  const bust = Date.now();
  const response = await fetch(`/api/inbox?date=${state.dateKey}&_=${bust}`);
  if (!response.ok) throw new Error("inbox API failed");
  const payload = await response.json();
  state.lastInboxPayload = payload;
  state.serverOnline = true;

  const manualItems = state.inbox.filter((item) => item.source === "manual");
  state.inbox = [...payload.items, ...manualItems];
  renderInbox(payload);
  await flushPendingInboxSyncs();
}

async function refreshMeetings() {
  const bust = Date.now();
  const response = await fetch(`/api/meetings?date=${state.dateKey}&_=${bust}`);
  if (!response.ok) throw new Error("meetings API failed");
  const payload = await response.json();
  state.meetings = (payload.days?.[state.dateKey] || []).map(normalizeMeeting);
  state.serverOnline = true;
}

function renderAll() {
  renderInbox(state.lastInboxPayload);
  renderPulse(state.lastInboxPayload);
  renderTimeline();
  renderMeetingChips();
  fitTimelineHours();
  updateTimeSummary();
  updateNowLine();
}

function fitTimelineHours() {
  const scroll = document.getElementById("timeline-scroll");
  if (!scroll) return;
  const hours = END_HOUR - START_HOUR;
  document.documentElement.style.setProperty("--timeline-hours", String(hours));
  const fitted = Math.max(MIN_HOUR_HEIGHT_PX, Math.floor(scroll.clientHeight / hours));
  document.documentElement.style.setProperty("--hour-height", `${fitted}px`);
  positionTimelineBlocks();
  requestAnimationFrame(() => {
    requestAnimationFrame(scrollTimelineToEarliest);
  });
}

function scrollTimelineToEarliest() {
  const scroll = document.getElementById("timeline-scroll");
  if (!scroll) return;
  const starts = [
    ...state.meetings.map((meeting) => meeting.startMinutes ?? meeting.start),
    ...state.blocks.map((block) => block.startMinutes),
  ].filter((value) => Number.isFinite(value));
  if (!starts.length) {
    scroll.scrollTop = 0;
    return;
  }
  const earliest = Math.min(...starts);
  const buffer = Math.min(varHourHeight() * 0.5, 30);
  scroll.scrollTop = Math.max(0, minutesToY(earliest) - buffer);
}

function renderMeetingChips() {
  if (!els.meetingChips) return;
  const nextMeeting = nextMeetingForChip(state.meetings, state.dateKey);
  if (!nextMeeting) {
    els.meetingChips.hidden = true;
    els.meetingChips.innerHTML = "";
    return;
  }

  const start = nextMeeting.startMinutes ?? nextMeeting.start;
  const join = nextMeeting.joinUrl
    ? `<a class="meeting-chip-join" href="${escapeHtml(nextMeeting.joinUrl)}" target="_blank" rel="noopener">参加</a>`
    : "";

  els.meetingChips.hidden = false;
  els.meetingChips.innerHTML = `<button type="button" class="meeting-chip" data-meeting-start="${start}" title="${escapeHtml(nextMeeting.title)}">
    <span class="meeting-chip-time">${escapeHtml(minutesToClock(start))}</span>
    <span class="meeting-chip-title">${escapeHtml(nextMeeting.title)}</span>
    ${join}
  </button>`;

  const chip = els.meetingChips.querySelector(".meeting-chip");
  chip?.addEventListener("click", (event) => {
    if (event.target.closest(".meeting-chip-join")) return;
    scrollToMinutes(Number(chip.dataset.meetingStart));
  });
  els.meetingChips.querySelector(".meeting-chip-join")?.addEventListener("click", (event) => {
    event.stopPropagation();
  });
}

function nextMeetingForChip(meetings, dateKey) {
  const sorted = [...meetings]
    .map(normalizeMeeting)
    .sort((a, b) => a.startMinutes - b.startMinutes);
  if (!sorted.length) return null;

  const today = isoDate(new Date());
  if (dateKey < today) return null;
  if (dateKey > today) return sorted[0];

  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  return sorted.find((meeting) => meeting.startMinutes + meeting.duration > nowMinutes) || null;
}

function scrollToMinutes(startMinutes) {
  const scroll = document.getElementById("timeline-scroll");
  if (!scroll || !Number.isFinite(startMinutes)) return;
  const buffer = Math.min(varHourHeight() * 0.35, 24);
  scroll.scrollTop = Math.max(0, minutesToY(startMinutes) - buffer);
  const canvas = els.dayGrid.querySelector(".canvas");
  const target = [...(canvas?.querySelectorAll("[data-meeting-id]") || [])].find((node) => {
    const id = node.dataset.meetingId;
    const match = state.meetings.find((item) => item.id === id);
    return (match?.startMinutes ?? match?.start) === startMinutes;
  });
  if (target) {
    target.classList.add("meeting-block--highlight");
    window.setTimeout(() => target.classList.remove("meeting-block--highlight"), 1400);
  }
}

function renderInbox(apiPayload) {
  const openCount = state.inbox.filter((item) => !getInboxDone(item.id)).length;
  els.inboxCount.textContent = String(openCount);
  if (apiPayload) {
    const parts = [];
    if (apiPayload.drillFound) parts.push("ドリル");
    if (apiPayload.dailyFound) parts.push("デイリー");
    els.inboxSource.textContent = parts.length
      ? `保管庫: ${parts.join(" + ")} · タイムラインへドラッグで記録`
      : "この日のドリル/デイリーノートなし";
  }

  if (!state.inbox.length) {
    els.inboxList.innerHTML = '<p class="empty-inbox">インボックスは空 — ブロックを追加するか別の日を選んでください。</p>';
    return;
  }

  els.inboxList.innerHTML = state.inbox
    .map((item) => {
      const cat = CATEGORIES[item.category] || CATEGORIES.personal;
      const done = getInboxDone(item.id);
      const tracked = trackedMinutesForItem(item.id);
      const metaParts = [];
      if (tracked > 0) metaParts.push(`${formatDuration(tracked)} 記録済`);
      metaParts.push(`デフォルト ${item.duration}分`);
      if (item.sections?.length) metaParts.push(`${item.sections.length} セクション`);
      else metaParts.push(cat.label);
      const meta = metaParts.join(" · ");
      return `
        <li class="inbox-item${done ? " inbox-item--done" : ""}" draggable="true" data-id="${item.id}">
          <input type="checkbox" class="inbox-check" data-id="${item.id}" ${done ? "checked" : ""} aria-label="${escapeHtml(item.title)} を完了にする" />
          <span class="chip" style="background:${cat.color};border:1px solid ${cat.border}"></span>
          <div class="item-copy">
            <div class="item-title">${escapeHtml(item.title)}</div>
            <div class="item-meta">${escapeHtml(meta)}</div>
          </div>
        </li>`;
    })
    .join("");

  els.inboxList.querySelectorAll(".inbox-item").forEach((node) => {
    node.addEventListener("dragstart", onInboxDragStart);
    node.addEventListener("dragend", onDragEnd);
  });

  els.inboxList.querySelectorAll(".inbox-check").forEach((node) => {
    node.addEventListener("mousedown", (event) => event.stopPropagation());
    node.addEventListener("click", (event) => event.stopPropagation());
    node.addEventListener("change", onInboxCheckChange);
  });
}

function renderPulse(apiPayload) {
  const items = apiPayload?.pulse || [];
  if (!items.length) {
    els.pulseList.innerHTML = '<p class="empty-pulse">デイリーノートにパルスなし。</p>';
    return;
  }

  els.pulseList.innerHTML = items
    .map(
      (item) => `
      <div class="pulse-item">
        <div class="pulse-initiative">${escapeHtml(item.initiative)}</div>
        <div class="pulse-text">${escapeHtml(item.summary)}</div>
      </div>`
    )
    .join("");
}

function renderTimeline() {
  const totalHours = END_HOUR - START_HOUR;
  const hourLabels = Array.from({ length: totalHours }, (_, index) => {
    const hour = START_HOUR + index;
    return `<div class="hour-label">${formatHour(hour)}</div>`;
  }).join("");

  els.dayGrid.innerHTML = `
    <div class="hours">${hourLabels}</div>
    <div class="canvas" data-date="${state.dateKey}"></div>
  `;

  const canvas = els.dayGrid.querySelector(".canvas");
  canvas.addEventListener("dragover", onCanvasDragOver);
  canvas.addEventListener("dragleave", onCanvasDragLeave);
  canvas.addEventListener("drop", onCanvasDrop);

  for (const block of state.blocks) {
    canvas.appendChild(createFocusBlock(block, canvas));
  }
  for (const layout of computeMeetingLayouts(state.meetings)) {
    canvas.appendChild(createMeetingBlock(layout));
  }

  const nowLine = document.createElement("div");
  nowLine.className = "now-line hidden";
  nowLine.id = "now-line";
  canvas.appendChild(nowLine);
  positionTimelineBlocks();
}

function positionTimelineBlocks() {
  const canvas = els.dayGrid.querySelector(".canvas");
  if (!canvas) return;
  for (const layout of computeMeetingLayouts(state.meetings)) {
    const node = canvas.querySelector(`[data-meeting-id="${layout.meeting.id}"]`);
    if (node) applyMeetingLayout(node, layout);
  }
  for (const block of state.blocks) {
    const node = canvas.querySelector(`[data-block-id="${block.id}"]`);
    if (node) {
      node.style.top = `${minutesToY(block.startMinutes)}px`;
      node.style.height = `${minutesToHeight(block.duration)}px`;
    }
  }
  updateNowLine();
}

function computeMeetingLayouts(meetings) {
  const items = meetings
    .map((meeting) => {
      const startMinutes = meeting.startMinutes ?? meeting.start;
      const height = meetingDisplayHeight({ ...meeting, startMinutes });
      return {
        meeting,
        startMinutes,
        top: minutesToY(startMinutes),
        height,
        lane: 0,
        laneCount: 1,
      };
    })
    .sort((a, b) => a.startMinutes - b.startMinutes);

  if (!items.length) return items;

  const parent = items.map((_, index) => index);
  const find = (index) => {
    if (parent[index] !== index) parent[index] = find(parent[index]);
    return parent[index];
  };
  const union = (a, b) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[rootB] = rootA;
  };

  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      if (meetingsOverlap(items[i], items[j])) union(i, j);
    }
  }

  const groups = new Map();
  items.forEach((item, index) => {
    const root = find(index);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(item);
  });

  for (const group of groups.values()) {
    if (group.length === 1) {
      group[0].lane = 0;
      group[0].laneCount = 1;
      continue;
    }

    group.sort((a, b) => a.startMinutes - b.startMinutes);
    for (let i = 0; i < group.length; i += 1) {
      for (let j = 0; j < i; j += 1) {
        if (meetingsOverlap(group[i], group[j])) {
          group[i].lane = Math.max(group[i].lane, group[j].lane + 1);
        }
      }
    }
    const laneCount = Math.max(...group.map((item) => item.lane + 1));
    group.forEach((item) => {
      item.laneCount = laneCount;
    });
  }

  return items;
}

function meetingsOverlap(a, b) {
  return a.top < b.top + b.height && b.top < a.top + a.height;
}

function applyMeetingLayout(node, layout) {
  const canvas = node.parentElement;
  const canvasWidth = canvas?.clientWidth || 0;
  node.style.top = `${layout.top}px`;
  node.style.height = `${layout.height}px`;
  node.style.zIndex = String(30 + layout.lane);

  if (layout.laneCount <= 1 || canvasWidth < 120) {
    node.style.left = "10px";
    node.style.right = "10px";
    node.style.width = "auto";
    return;
  }

  const pad = 10;
  const gap = 4;
  const usable = Math.max(canvasWidth - pad * 2, 80);
  const laneWidth = Math.max((usable - gap * (layout.laneCount - 1)) / layout.laneCount, 48);
  const left = pad + layout.lane * (laneWidth + gap);
  node.style.left = `${left}px`;
  node.style.right = "auto";
  node.style.width = `${laneWidth}px`;
}

function normalizeMeeting(meeting) {
  return {
    ...meeting,
    startMinutes: meeting.startMinutes ?? meeting.start,
  };
}

function createMeetingBlock(layout) {
  const meeting = layout.meeting;
  const compact = meeting.duration <= 30;
  const node = document.createElement("article");
  node.className = `block meeting-block${compact ? " meeting-block--compact" : ""}`;
  node.dataset.meetingId = meeting.id;

  const joinLink = meeting.joinUrl
    ? `<a class="join-btn" href="${escapeHtml(meeting.joinUrl)}" target="_blank" rel="noopener">参加</a>`
    : "";

  node.innerHTML = `
    <div class="block-body">
      <div class="block-title" title="${escapeHtml(meeting.title)}">${escapeHtml(meeting.title)}</div>
      <div class="block-time">${escapeHtml(formatBlockTime(layout.startMinutes, meeting.duration))}</div>
    </div>
    ${joinLink}
  `;
  applyMeetingLayout(node, layout);
  return node;
}

function meetingDisplayHeight(meeting) {
  const proportional = minutesToHeight(meeting.duration);
  if (meeting.duration <= 30) {
    return Math.max(proportional, MIN_MEETING_HEIGHT_PX);
  }
  return Math.max(proportional, 28);
}

function createFocusBlock(block, canvas) {
  const cat = CATEGORIES[block.category] || CATEGORIES.personal;
  const node = document.createElement("article");
  node.className = "block";
  node.dataset.blockId = block.id;
  node.style.top = `${minutesToY(block.startMinutes)}px`;
  node.style.height = `${minutesToHeight(block.duration)}px`;
  node.style.background = cat.color;
  node.style.borderColor = cat.border;
  node.style.color = cat.text;

  node.innerHTML = `
    <div class="block-title">${escapeHtml(block.title)}</div>
    <div class="block-time">${escapeHtml(formatBlockTime(block.startMinutes, block.duration))}</div>
    <div class="block-resize" aria-hidden="true"></div>
  `;

  node.addEventListener("dblclick", () => openEditDialog(block.id));
  node.addEventListener("dragstart", (event) => onBlockDragStart(event, block.id));
  node.addEventListener("dragend", onDragEnd);
  node.querySelector(".block-resize").addEventListener("mousedown", (event) => startResize(event, block.id));
  node.addEventListener("mousedown", (event) => {
    if (event.target.classList.contains("block-resize")) return;
    startMove(event, block.id, canvas);
  });

  return node;
}

function updateTimeSummary() {
  const meetingMinutes = state.meetings.reduce((sum, item) => sum + item.duration, 0);
  const focusMinutes = state.blocks.reduce((sum, item) => sum + item.duration, 0);
  const meetingCount = state.meetings.length;
  const meetingLabel = meetingCount
    ? `会議 ${meetingCount}件 · ${formatDuration(meetingMinutes)}`
    : `会議 ${formatDuration(meetingMinutes)}`;
  els.timeSummary.textContent = `${meetingLabel} · 集中 ${formatDuration(focusMinutes)}`;
}

function updateNowLine() {
  const line = document.getElementById("now-line");
  if (!line) return;
  const today = isoDate(new Date());
  if (state.dateKey !== today) {
    line.classList.add("hidden");
    return;
  }
  const now = new Date();
  const minutes = now.getHours() * 60 + now.getMinutes();
  if (minutes < START_HOUR * 60 || minutes > END_HOUR * 60) {
    line.classList.add("hidden");
    return;
  }
  line.style.top = `${minutesToY(minutes)}px`;
  line.classList.remove("hidden");
}

function onInboxDragStart(event) {
  const target = event.currentTarget;
  const item = state.inbox.find((entry) => entry.id === target.dataset.id);
  if (!item) return;
  state.dragPayload = { type: "inbox", item: { ...item } };
  event.dataTransfer.effectAllowed = "copy";
  event.dataTransfer.setData("text/plain", item.title);

  target.classList.add("dragging");
  const cat = CATEGORIES[item.category] || CATEGORIES.personal;
  state.dragGhostEl = document.createElement("div");
  state.dragGhostEl.className = "drag-ghost";
  state.dragGhostEl.innerHTML = `
    <span class="drag-ghost-chip" style="background:${cat.color};border:1px solid ${cat.border}"></span>
    <span class="drag-ghost-title">${escapeHtml(item.title)}</span>
  `;
  document.body.appendChild(state.dragGhostEl);
  event.dataTransfer.setDragImage(state.dragGhostEl, 16, 20);
}

function onBlockDragStart(event, blockId) {
  const block = state.blocks.find((entry) => entry.id === blockId);
  if (!block) return;
  state.dragPayload = { type: "block", blockId, block: { ...block } };
  event.dataTransfer.effectAllowed = "move";
}

function onDragEnd() {
  document.querySelectorAll(".inbox-item.dragging").forEach((node) => node.classList.remove("dragging"));
  if (state.dragGhostEl) {
    state.dragGhostEl.remove();
    state.dragGhostEl = null;
  }
  state.dragPayload = null;
  clearDropPreview();
}

function onCanvasDragOver(event) {
  event.preventDefault();
  if (!state.dragPayload) return;
  const canvas = event.currentTarget;
  canvas.classList.add("drag-over");
  const minutes = snapMinutes(yToMinutes(event.offsetY));
  showDropPreview(canvas, minutes, previewDuration());
}

function onCanvasDragLeave(event) {
  if (event.currentTarget.contains(event.relatedTarget)) return;
  event.currentTarget.classList.remove("drag-over");
  clearDropPreview();
}

function onCanvasDrop(event) {
  event.preventDefault();
  const canvas = event.currentTarget;
  canvas.classList.remove("drag-over");
  clearDropPreview();
  if (!state.dragPayload) return;

  const startMinutes = snapMinutes(yToMinutes(event.offsetY));
  if (state.dragPayload.type === "inbox") {
    const item = state.dragPayload.item;
    state.blocks.push({
      id: uid("block"),
      title: item.title,
      category: item.category,
      duration: item.duration,
      startMinutes,
      sourceItemId: item.id,
    });
  } else if (state.dragPayload.type === "block") {
    const block = state.blocks.find((entry) => entry.id === state.dragPayload.blockId);
    if (block) block.startMinutes = clampStart(startMinutes, block.duration);
  }

  state.dragPayload = null;
  persistAndRender();
}

function previewDuration() {
  if (!state.dragPayload) return 45;
  if (state.dragPayload.type === "inbox") return state.dragPayload.item.duration;
  return state.dragPayload.block.duration;
}

function showDropPreview(canvas, startMinutes, duration) {
  clearDropPreview();
  const preview = document.createElement("div");
  preview.className = "drop-preview";
  preview.style.top = `${minutesToY(startMinutes)}px`;
  preview.style.height = `${minutesToHeight(duration)}px`;
  canvas.appendChild(preview);
  state.dropPreview = preview;
}

function clearDropPreview() {
  if (state.dropPreview) {
    state.dropPreview.remove();
    state.dropPreview = null;
  }
}

function startResize(event, blockId) {
  event.preventDefault();
  event.stopPropagation();
  const block = state.blocks.find((entry) => entry.id === blockId);
  if (!block) return;
  state.resizeState = { blockId, startY: event.clientY, startDuration: block.duration };
  window.addEventListener("mousemove", onResizeMove);
  window.addEventListener("mouseup", onResizeEnd);
}

function onResizeMove(event) {
  if (!state.resizeState) return;
  const delta = event.clientY - state.resizeState.startY;
  const deltaMinutes = snapMinutes(Math.round((delta / varHourHeight()) * 60));
  const block = state.blocks.find((entry) => entry.id === state.resizeState.blockId);
  if (!block) return;
  block.duration = Math.max(MIN_BLOCK_MINUTES, state.resizeState.startDuration + deltaMinutes);
  renderTimeline();
  updateTimeSummary();
  renderInbox(state.lastInboxPayload);
}

function onResizeEnd() {
  state.resizeState = null;
  window.removeEventListener("mousemove", onResizeMove);
  window.removeEventListener("mouseup", onResizeEnd);
  persistDay();
  renderInbox(state.lastInboxPayload);
}

function startMove(event, blockId, canvas) {
  if (event.button !== 0) return;
  event.preventDefault();
  const block = state.blocks.find((entry) => entry.id === blockId);
  if (!block) return;
  const rect = canvas.getBoundingClientRect();
  state.moveState = {
    blockId,
    offsetY: event.clientY - rect.top - minutesToY(block.startMinutes),
    canvas,
  };
  window.addEventListener("mousemove", onMoveDrag);
  window.addEventListener("mouseup", onMoveEnd);
}

function onMoveDrag(event) {
  if (!state.moveState) return;
  const rect = state.moveState.canvas.getBoundingClientRect();
  const y = event.clientY - rect.top - state.moveState.offsetY;
  const block = state.blocks.find((entry) => entry.id === state.moveState.blockId);
  if (!block) return;
  block.startMinutes = clampStart(snapMinutes(yToMinutes(y)), block.duration);
  renderTimeline();
  updateTimeSummary();
}

function onMoveEnd() {
  state.moveState = null;
  window.removeEventListener("mousemove", onMoveDrag);
  window.removeEventListener("mouseup", onMoveEnd);
  persistDay();
}

function openEditDialog(blockId) {
  const block = state.blocks.find((entry) => entry.id === blockId);
  if (!block) return;
  state.editingBlockId = blockId;
  els.editTitle.value = block.title;
  els.editCategory.value = block.category;
  els.editStart.value = minutesToTimeInput(block.startMinutes);
  els.editDuration.value = block.duration;
  els.editDialog.showModal();
}

function saveEditedBlock() {
  const block = state.blocks.find((entry) => entry.id === state.editingBlockId);
  if (!block) return;
  block.title = els.editTitle.value.trim() || block.title;
  block.category = els.editCategory.value;
  block.duration = Math.max(MIN_BLOCK_MINUTES, Number(els.editDuration.value) || block.duration);
  block.startMinutes = clampStart(timeInputToMinutes(els.editStart.value), block.duration);
  els.editDialog.close();
  persistAndRender();
}

function deleteEditedBlock() {
  state.blocks = state.blocks.filter((entry) => entry.id !== state.editingBlockId);
  els.editDialog.close();
  persistAndRender();
}

function onInboxCheckChange(event) {
  const itemId = event.currentTarget.dataset.id;
  const done = event.currentTarget.checked;
  setInboxDone(itemId, done);
  renderInbox(state.lastInboxPayload);
  void syncInboxDoneToDaily(itemId, done)
    .then(() => {
      if (done) setStatus("デイリーノートに反映しました。");
    })
    .catch((error) => {
      setStatus(`タスク同期失敗: ${error.message}`, true);
    });
}

function getInboxDone(itemId) {
  return Boolean(readStorage().inboxStateByDate?.[state.dateKey]?.[itemId]?.done);
}

function setInboxDone(itemId, done) {
  const stored = readStorage();
  if (!stored.inboxStateByDate) stored.inboxStateByDate = {};
  if (!stored.inboxStateByDate[state.dateKey]) stored.inboxStateByDate[state.dateKey] = {};
  stored.inboxStateByDate[state.dateKey][itemId] = {
    ...stored.inboxStateByDate[state.dateKey][itemId],
    done: Boolean(done),
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
}

function trackedMinutesForItem(itemId) {
  if (!itemId) return 0;
  return state.blocks
    .filter((block) => block.sourceItemId === itemId)
    .reduce((sum, block) => sum + block.duration, 0);
}

function addManualInboxItem() {
  const title = els.taskTitle.value.trim();
  if (!title) return;
  state.inbox.push({
    id: uid("manual"),
    title,
    duration: Number(els.taskDuration.value) || 45,
    category: els.taskCategory.value,
    source: "manual",
    sourceDate: state.dateKey,
  });
  els.taskTitle.value = "";
  renderInbox(state.lastInboxPayload);
}

function clearFocusBlocks() {
  if (!state.blocks.length) return;
  if (!window.confirm("この日の集中ブロックをすべてクリアしますか？")) return;
  state.blocks = [];
  persistAndRender();
}

async function saveNote() {
  const content = els.noteEditor.value;
  if (!content.trim()) {
    setStatus("保存する内容がありません。", true);
    return;
  }
  setStatus("保存中…");
  try {
    const response = await fetch("/api/note/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    const payload = await response.json();
    if (!payload.ok) {
      setStatus(payload.message || "保存に失敗しました。", true);
      return;
    }
    els.noteEditor.value = "";
    setStatus(`${payload.filename} を保存 → 00-inbox/`);
  } catch (error) {
    setStatus(`保存に失敗しました: ${error.message}`, true);
  }
}

async function runGoodMorning() {
  setStatus("おはようワークフローを開始中…");
  try {
    const response = await fetch("/api/workflow/good-morning", { method: "POST", body: "{}" });
    const payload = await response.json();
    setStatus(payload.message || "完了。", !payload.ok);
  } catch (error) {
    setStatus(`失敗: ${error.message}`, true);
  }
}

async function runEndOfDay() {
  setStatus("終業スイープを送信中…");
  try {
    const response = await fetch("/api/workflow/end-of-day", { method: "POST", body: "{}" });
    const payload = await response.json();
    setStatus(payload.message || "完了。", !payload.ok);
  } catch (error) {
    setStatus(`失敗: ${error.message}`, true);
  }
}

function togglePomodoro() {
  if (pomodoro.running) {
    pausePomodoro();
  } else {
    startPomodoro();
  }
}

function startPomodoro() {
  if (pomodoro.running) return;
  if (pomodoro.mode === "focus") {
    pomodoro.focusStartMinutes = snapMinutes(currentMinutesNow());
  }
  pomodoro.running = true;
  pomodoro.endAt = Date.now() + pomodoro.secondsLeft * 1000;
  pomodoro.timerId = window.setInterval(tickPomodoro, 1000);
  updatePomodoroControls();
}

function pausePomodoro() {
  if (pomodoro.running && pomodoro.endAt) {
    pomodoro.secondsLeft = Math.max(0, Math.ceil((pomodoro.endAt - Date.now()) / 1000));
  }
  pomodoro.running = false;
  pomodoro.endAt = null;
  if (pomodoro.timerId) window.clearInterval(pomodoro.timerId);
  pomodoro.timerId = null;
  updatePomodoroControls();
  updatePomodoroDisplay();
}

function getPomodoroPreset() {
  return POMODORO_PRESETS[pomodoro.preset];
}

function setPomodoroPreset(key) {
  if (pomodoro.running || pomodoro.preset === key) return;
  pomodoro.preset = key;
  resetPomodoro();
  updatePresetButtons();
}

function updatePresetButtons() {
  els.presetShort.classList.toggle("active", pomodoro.preset === "short");
  els.presetLong.classList.toggle("active", pomodoro.preset === "long");
}

function resetPomodoro() {
  pausePomodoro();
  pomodoro.mode = "focus";
  pomodoro.secondsLeft = getPomodoroPreset().focus;
  pomodoro.endAt = null;
  pomodoro.focusStartMinutes = null;
  updatePomodoroDisplay();
  updatePomodoroControls();
}

function tickPomodoro() {
  syncPomodoroFromClock();
}

function syncPomodoroFromClock() {
  if (!pomodoro.running || pomodoro.endAt == null) {
    updatePomodoroDisplay();
    return;
  }

  const preset = getPomodoroPreset();
  while (Date.now() >= pomodoro.endAt) {
    if (pomodoro.mode === "focus") {
      if (document.visibilityState === "visible") {
        recordCompletedFocusSession();
      } else {
        pomodoro.focusStartMinutes = null;
      }
    }
    pomodoro.mode = pomodoro.mode === "focus" ? "break" : "focus";
    const phaseSeconds = pomodoro.mode === "focus" ? preset.focus : preset.break;
    pomodoro.secondsLeft = phaseSeconds;
    pomodoro.endAt = Date.now() + phaseSeconds * 1000;
    if (pomodoro.mode === "focus") {
      pomodoro.focusStartMinutes = snapMinutes(currentMinutesNow());
    }
  }

  pomodoro.secondsLeft = Math.max(0, Math.ceil((pomodoro.endAt - Date.now()) / 1000));
  updatePomodoroDisplay();
}

function recordCompletedFocusSession() {
  const preset = getPomodoroPreset();
  const duration = preset.focus / 60;
  const endMinutes = snapMinutes(currentMinutesNow());
  const startMinutes = clampStart(pomodoro.focusStartMinutes ?? endMinutes - duration, duration);
  const today = isoDate(new Date());
  const block = {
    id: uid("pomo"),
    title: preset.blockTitle,
    category: "personal",
    duration,
    startMinutes,
    source: "pomodoro",
  };

  if (state.dateKey === today) {
    state.blocks.push(block);
    persistAndRender();
    setStatus(`タイムラインに ${duration}分の集中を記録しました。`);
  } else {
    const stored = readStorage();
    stored.blocksByDate[today] = stored.blocksByDate[today] || [];
    stored.blocksByDate[today].push(block);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    saveBlocksToServer(today, stored.blocksByDate[today]).catch(() => {});
    setStatus(`${today} に ${duration}分の集中を記録しました。`);
  }
  pomodoro.focusStartMinutes = null;
}

function currentMinutesNow() {
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes();
}

function updatePomodoroDisplay() {
  const preset = getPomodoroPreset();
  const minutes = Math.floor(pomodoro.secondsLeft / 60);
  const seconds = pomodoro.secondsLeft % 60;
  els.pomodoroDisplay.textContent = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  const phase = pomodoro.mode === "focus" ? "集中" : "休憩";
  els.pomodoroMode.textContent = `${phase} · ${preset.label}`;
}

function updatePomodoroControls() {
  const running = pomodoro.running;
  els.pomodoroToggle.textContent = running ? "一時停止" : "開始";
  els.pomodoroToggle.classList.toggle("primary", !running);
  els.pomodoroToggle.classList.toggle("ghost", running);
}

function setStatus(message, isError = false) {
  els.noteStatus.textContent = message;
  els.noteStatus.style.color = isError ? "#e879a9" : "";
}

function persistAndRender() {
  persistDay();
  renderAll();
}

function persistDay() {
  const stored = readStorage();
  stored.blocksByDate[state.dateKey] = state.blocks;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  scheduleSyncBlocksToDaily();
}

function scheduleSyncBlocksToDaily() {
  if (!state.serverOnline) return;
  clearTimeout(syncBlocksTimer);
  syncBlocksTimer = setTimeout(() => {
    saveBlocksToServer().catch(() => {});
  }, 400);
}

async function loadBlocksFromServer() {
  try {
    const response = await fetch(`/api/blocks?date=${state.dateKey}&_=${Date.now()}`);
    if (!response.ok) return;
    const payload = await response.json();
    if (!payload.ok || !Array.isArray(payload.blocks)) return;

    state.blocks = payload.blocks.map(normalizeStoredBlock);
    const stored = readStorage();
    stored.blocksByDate[state.dateKey] = state.blocks;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    renderTimeline();
    updateTimeSummary();
    renderInbox(state.lastInboxPayload);
  } catch {
    /* keep localStorage fallback */
  }
}

function normalizeStoredBlock(raw) {
  return {
    id: raw.id || uid("block"),
    title: String(raw.title || "Untitled").trim(),
    category: CATEGORIES[raw.category] ? raw.category : "personal",
    duration: Number(raw.duration) || 45,
    startMinutes: Number(raw.startMinutes) || START_HOUR * 60,
    source: raw.source || null,
    sourceItemId: raw.sourceItemId || null,
  };
}

function serializeBlocks(blocks) {
  return blocks.map((block) => ({
    id: block.id,
    title: block.title,
    category: block.category,
    duration: block.duration,
    startMinutes: block.startMinutes,
    source: block.source || null,
    sourceItemId: block.sourceItemId || null,
  }));
}

async function flushPendingInboxSyncs() {
  for (const item of state.inbox) {
    if (item.source === "manual") continue;
    if (!getInboxDone(item.id)) continue;
    try {
      await syncInboxDoneToDaily(item.id, true);
    } catch {
      /* keep local check; user can toggle to retry */
    }
  }
}

async function syncInboxDoneToDaily(itemId, done) {
  const item = state.inbox.find((entry) => entry.id === itemId);
  if (!item || item.source === "manual") {
    return { ok: true, skipped: true };
  }

  const response = await fetch("/api/daily/sync-inbox-done", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      date: state.dateKey,
      itemId,
      done: Boolean(done),
    }),
  });
  if (!response.ok) throw new Error("inbox sync failed");
  const payload = await response.json();
  if (!payload.ok && !payload.skipped) throw new Error(payload.message || "inbox sync failed");
  return payload;
}

async function saveBlocksToServer(dateKey = state.dateKey, blocks = state.blocks) {
  if (!state.serverOnline) return;
  const response = await fetch("/api/blocks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      date: dateKey,
      blocks: serializeBlocks(blocks),
    }),
  });
  if (!response.ok) throw new Error("block save failed");
  const payload = await response.json();
  if (!payload.ok) throw new Error(payload.message || "block save failed");
  return payload;
}

async function syncBlocksToDaily() {
  return saveBlocksToServer();
}

function readStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { blocksByDate: {}, inboxStateByDate: {} };
    const parsed = JSON.parse(raw);
    return {
      blocksByDate: parsed.blocksByDate || {},
      inboxStateByDate: parsed.inboxStateByDate || {},
    };
  } catch {
    return { blocksByDate: {}, inboxStateByDate: {} };
  }
}

async function shiftDay(delta) {
  const date = parseDateKey(state.dateKey);
  date.setDate(date.getDate() + delta);
  await loadDay(isoDate(date));
  renderAll();
}

async function goToDate(dateKey) {
  if (!dateKey) return;
  await loadDay(dateKey);
  renderAll();
}

function isoDate(date) {
  const copy = new Date(date);
  copy.setMinutes(copy.getMinutes() - copy.getTimezoneOffset());
  return copy.toISOString().slice(0, 10);
}

function parseDateKey(dateKey) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function formatDayLabel(dateKey) {
  return parseDateKey(dateKey).toLocaleDateString("ja-JP", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

function formatHour(hour) {
  return `${hour}時`;
}

function formatBlockTime(startMinutes, duration) {
  return `${minutesToClock(startMinutes)} – ${minutesToClock(startMinutes + duration)}`;
}

function minutesToClock(totalMinutes) {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function minutesToTimeInput(totalMinutes) {
  return minutesToClock(totalMinutes);
}

function timeInputToMinutes(value) {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function formatDuration(totalMinutes) {
  if (!totalMinutes) return "0分";
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (!hours) return `${minutes}分`;
  if (!minutes) return `${hours}時間`;
  return `${hours}時間${minutes}分`;
}

function varHourHeight() {
  return parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--hour-height")) || 72;
}

function minutesToY(minutes) {
  return ((minutes - START_HOUR * 60) / 60) * varHourHeight();
}

function yToMinutes(y) {
  return START_HOUR * 60 + (y / varHourHeight()) * 60;
}

function minutesToHeight(duration) {
  return (duration / 60) * varHourHeight();
}

function snapMinutes(minutes) {
  return Math.round(minutes / SNAP_MINUTES) * SNAP_MINUTES;
}

function clampStart(startMinutes, duration) {
  const min = START_HOUR * 60;
  const max = END_HOUR * 60 - duration;
  return Math.min(Math.max(startMinutes, min), max);
}

function uid(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

updatePomodoroDisplay();
updatePresetButtons();

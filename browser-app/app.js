"use strict";

(() => {
  const DATABASE = "motion-organizer-browser";
  const STORE = "events";
  const MAX_EVENTS = 100;
  const GRID_WIDTH = 72;
  const GRID_HEIGHT = 40;
  const CHANGE_THRESHOLD = 26;
  const CHANGED_RATIO = 0.035;
  const AVERAGE_CHANGE = 5;
  const SAMPLE_INTERVAL_SECONDS = 1;
  const CAMERA_SAMPLE_MS = 280;
  const CAMERA_EVENT_GAP_MS = 5_000;
  const REGION_LIMIT = 8;
  const BACKUP_FORMAT = "motion-organizer-reports";
  const BACKUP_VERSION = 1;
  const MAX_BACKUP_BYTES = 2 * 1024 * 1024;
  const BACKUP_DEVICE_KEY = "motion-organizer-backup-device-id";
  const REGION_STORAGE_KEY = "motion-organizer-regions";
  const CATEGORY_STORAGE_KEY = "motion-organizer-custom-categories";

  const elements = {};
  const state = {
    db: null,
    results: [],
    filter: "All",
    category: "auto",
    stream: null,
    cameraTimer: null,
    previousFrame: null,
    selectedFile: null,
    selectedObjectUrl: null,
    analysisController: null,
    toastTimer: null,
    deferredInstallPrompt: null,
    regions: [],
    customCategories: [],
    recordingMode: "events",
    cameraMotion: null,
    lastMotionAt: 0,
    lastQuietReportAt: 0,
  };

  function collectElements() {
    const ids = [
      "activity-list", "activity-footnote", "analysis-box", "analysis-message",
      "analysis-percent", "analysis-progress", "cancel-analysis", "category-choice",
      "category-filters", "clear-history", "filter-all-count", "install-button",
      "live-badge", "media-status", "nav-count", "pick-video", "pick-video-nav",
      "platform-label", "preview", "stage-empty", "start-camera", "stat-pets",
      "stat-people", "stat-total", "stop-camera", "toast", "video-input",
      "add-region", "region-list", "region-layer", "recording-mode",
      "notifications-enabled", "quiet-period", "custom-category", "save-category",
      "custom-category-list", "export-backup", "import-backup", "backup-input",
      "connection-status",
    ];
    for (const id of ids) {
      const element = document.getElementById(id);
      if (!element) throw new Error(`Missing app interface element: #${id}`);
      elements[id.replaceAll("-", "_")] = element;
    }
  }

  function openDatabase() {
    return new Promise((resolve, reject) => {
      if (!("indexedDB" in window)) {
        reject(new Error("This browser doesn't support local activity storage."));
        return;
      }

      const request = indexedDB.open(DATABASE, 2);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORE)) {
          const store = database.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
          store.createIndex("createdAt", "createdAt");
          store.createIndex("category", "category");
        }
        if (!database.objectStoreNames.contains("sources")) {
          database.createObjectStore("sources", { keyPath: "id" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Couldn't open local activity storage."));
      request.onblocked = () => reject(new Error("Close other Motion Organizer tabs to enable storage updates."));
    });
  }

  function transact(mode, operation) {
    return new Promise((resolve, reject) => {
      const transaction = state.db.transaction(STORE, mode);
      const store = transaction.objectStore(STORE);
      let request;
      try {
        request = operation(store);
      } catch (error) {
        reject(error);
        return;
      }
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("The activity storage operation failed."));
      transaction.onabort = () => reject(transaction.error || new Error("The activity storage operation was cancelled."));
    });
  }

  function readStoredJson(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      return value === null ? fallback : JSON.parse(value);
    } catch (error) {
      throw new Error(`Couldn't read saved settings: ${error.message}`);
    }
  }

  function saveStoredJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      throw new Error(`Couldn't save settings on this device: ${error.message}`);
    }
  }

  function backupDeviceId() {
    let id = localStorage.getItem(BACKUP_DEVICE_KEY);
    if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(BACKUP_DEVICE_KEY, id);
    }
    return id;
  }

  function renderConnectionStatus() {
    const online = navigator.onLine;
    elements.connection_status.textContent = online
    ? "Online · reports stay local"
    : "Offline · local mode";
    elements.connection_status.parentElement.classList.toggle("offline", !online);
  }

  function reportBackupEvent(event, deviceId) {
    return {
    backupId: event.backupId || `${deviceId}:${event.id}`,
    title: String(event.title || "Activity report").slice(0, 256),
    category: String(event.category || "Other motion").slice(0, 64),
    timestamp: Number(event.createdAt || event.timestamp),
    samples: Number(event.samples ?? event.motionSamples ?? 0),
    report: String(event.report || "").slice(0, 2000),
    };
  }

  async function exportReports() {
    try {
    const deviceId = backupDeviceId();
    const backup = {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      createdAt: Date.now(),
      events: state.results.map((event) => reportBackupEvent(event, deviceId)),
    };
    const file = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(file);
    const link = document.createElement("a");
    link.href = url;
    link.download = `motion-organizer-reports-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    showToast("Report backup exported. Save it to a cloud drive to move reports between devices; clips remain local.");
    } catch (error) {
    showToast(`Couldn't export reports: ${error.message}`, true);
    }
  }

  async function importReports(file) {
    if (!file) return;
    if (file.size > MAX_BACKUP_BYTES) {
    showToast("That backup is larger than 2 MB. Choose a report-only Motion Organizer backup.", true);
    return;
    }
    try {
    const backup = JSON.parse(await file.text());
    if (backup?.format !== BACKUP_FORMAT || backup.version !== BACKUP_VERSION ||
      !Array.isArray(backup.events) || backup.events.length > 1_000) {
      throw new Error("This file isn't a supported Motion Organizer report backup.");
    }

    const deviceId = backupDeviceId();
    const knownIds = new Set(state.results.map((event) => event.backupId || `${deviceId}:${event.id}`));
    const importedIds = new Set();
    for (const event of backup.events) {
      if (!event || typeof event.title !== "string" || typeof event.category !== "string" ||
        !Number.isFinite(Number(event.timestamp)) || Number(event.timestamp) <= 0 ||
        typeof event.backupId !== "string" || event.backupId.length > 200) {
        continue;
      }
      if (knownIds.has(event.backupId)) continue;
      const samples = Number(event.samples ?? event.motionSamples ?? 0);
      if (!Number.isInteger(samples) || samples < 0 || samples > 10_000_000) continue;
      await saveEvent({
        backupId: event.backupId,
        title: event.title.slice(0, 256),
        category: event.category.slice(0, 64),
        source: "backup",
        samples,
        report: typeof event.report === "string" ? event.report.slice(0, 2_000) : "Imported report. Video clips remain on the device where they were recorded.",
        createdAt: Number(event.timestamp),
      });
      knownIds.add(event.backupId);
      importedIds.add(event.backupId);
    }
    const retained = state.results.filter((event) => importedIds.has(event.backupId)).length;
    showToast(retained
      ? `Imported ${retained} report${retained === 1 ? "" : "s"}. Video clips aren't included in report backups.` +
        (retained < importedIds.size ? ` ${importedIds.size - retained} older reports weren't kept because history is limited to ${MAX_EVENTS}.` : "")
      : "No new reports were found in that backup.");
    } catch (error) {
    showToast(`Couldn't import reports: ${error.message}`, true);
    }
  }

  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
  }

  function loadMonitorSettings() {
    const savedRegions = readStoredJson(REGION_STORAGE_KEY, null);
    const validRegions = Array.isArray(savedRegions)
      ? savedRegions.filter((region) =>
        region && typeof region.id === "string" && typeof region.name === "string" &&
        [region.x, region.y, region.width, region.height].every(Number.isFinite),
      ).slice(0, REGION_LIMIT).map((region) => {
        const x = clamp(region.x, 0, 0.92);
        const y = clamp(region.y, 0, 0.92);
        return {
          ...region,
          x,
          y,
          width: clamp(region.width, 0.08, 1 - x),
          height: clamp(region.height, 0.08, 1 - y),
          enabled: region.enabled !== false,
        };
      })
      : [];
    state.regions = validRegions.length ? validRegions
      : [{ id: crypto.randomUUID(), name: "Full view", x: 0.02, y: 0.02, width: 0.96, height: 0.96, enabled: true }];
    state.customCategories = readStoredJson(CATEGORY_STORAGE_KEY, []);
    if (!Array.isArray(state.customCategories) ||
      state.customCategories.some((category) => typeof category !== "string")) {
      throw new Error("Saved activity labels have an invalid format. Clear them in browser storage and try again.");
    }
    const savedMode = localStorage.getItem("motion-organizer-recording-mode");
    if (["events", "continuous", "off"].includes(savedMode)) elements.recording_mode.value = savedMode;
    state.recordingMode = elements.recording_mode.value;
    elements.notifications_enabled.checked = localStorage.getItem("motion-organizer-notifications") === "true";
    const quietPeriod = localStorage.getItem("motion-organizer-quiet-period");
    if (["60", "300", "900"].includes(quietPeriod)) elements.quiet_period.value = quietPeriod;
    renderRegions();
    renderCustomCategories();
  }

  function persistRegions() {
    try {
      saveStoredJson(REGION_STORAGE_KEY, state.regions);
      renderRegions();
    } catch (error) {
      showToast(error.message, true);
    }
  }

  function renderRegions() {
    elements.region_layer.replaceChildren();
    elements.region_list.replaceChildren();
    for (const region of state.regions) {
      const box = document.createElement("div");
      box.className = `detection-region${region.enabled ? "" : " region-disabled"}`;
      box.dataset.regionId = region.id;
      box.style.left = `${region.x * 100}%`;
      box.style.top = `${region.y * 100}%`;
      box.style.width = `${region.width * 100}%`;
      box.style.height = `${region.height * 100}%`;
      box.title = `${region.name} — drag to move; drag the corner to resize`;

      const label = document.createElement("span");
      label.className = "region-box-label";
      label.textContent = region.name;
      box.append(label);
      const handle = document.createElement("button");
      handle.type = "button";
      handle.className = "region-resize-handle";
      handle.setAttribute("aria-label", `Resize ${region.name}`);
      box.append(handle);
      box.addEventListener("pointerdown", (event) => startRegionDrag(event, region.id, event.target === handle));
      elements.region_layer.append(box);

      const row = document.createElement("div");
      row.className = "region-row";
      const enabled = document.createElement("input");
      enabled.type = "checkbox";
      enabled.checked = region.enabled;
      enabled.setAttribute("aria-label", `Include ${region.name} in motion detection`);
      enabled.addEventListener("change", () => {
        if (!enabled.checked && !state.regions.some((item) => item.id !== region.id && item.enabled)) {
          enabled.checked = true;
          showToast("Keep at least one detection region enabled.", true);
          return;
        }
        region.enabled = enabled.checked;
        persistRegions();
      });
      const name = document.createElement("input");
      name.type = "text";
      name.maxLength = 32;
      name.value = region.name;
      name.setAttribute("aria-label", "Region name");
      name.addEventListener("change", () => {
        region.name = name.value.trim() || `Region ${state.regions.indexOf(region) + 1}`;
        persistRegions();
      });
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "text-button";
      remove.textContent = "Remove";
      remove.addEventListener("click", () => {
        if (state.regions.length <= 1) {
          showToast("Keep at least one detection region.", true);
          return;
        }
        state.regions = state.regions.filter((item) => item.id !== region.id);
        persistRegions();
      });
      row.append(enabled, name, remove);
      elements.region_list.append(row);
    }
    elements.region_layer.hidden = state.regions.length === 0 || (!state.stream && !state.selectedFile);
  }

  function startRegionDrag(event, regionId, resize) {
    if (event.button !== 0 || !event.isPrimary) return;
    event.preventDefault();
    const layer = elements.region_layer.getBoundingClientRect();
    const region = state.regions.find((item) => item.id === regionId);
    if (!region || layer.width === 0 || layer.height === 0) return;
    const originX = event.clientX;
    const originY = event.clientY;
    const initial = { ...region };
    const onMove = (moveEvent) => {
      const dx = (moveEvent.clientX - originX) / layer.width;
      const dy = (moveEvent.clientY - originY) / layer.height;
      if (resize) {
        region.width = clamp(initial.width + dx, 0.08, 1 - initial.x);
        region.height = clamp(initial.height + dy, 0.08, 1 - initial.y);
      } else {
        region.x = clamp(initial.x + dx, 0, 1 - region.width);
        region.y = clamp(initial.y + dy, 0, 1 - region.height);
      }
      const box = elements.region_layer.querySelector(`[data-region-id="${CSS.escape(regionId)}"]`);
      if (box) {
        box.style.left = `${region.x * 100}%`;
        box.style.top = `${region.y * 100}%`;
        box.style.width = `${region.width * 100}%`;
        box.style.height = `${region.height * 100}%`;
      }
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      persistRegions();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  }

  function renderCustomCategories() {
    const choices = ["auto", "People", "Pets", "Other motion", ...state.customCategories];
    const current = elements.category_choice.value || "auto";
    elements.category_choice.replaceChildren(...choices.map((category) => {
      const option = document.createElement("option");
      option.value = category;
      option.textContent = category === "auto" ? "Auto — other motion" : category;
      return option;
    }));
    elements.category_choice.value = choices.includes(current) ? current : "auto";

    const saved = document.createDocumentFragment();
    for (const category of state.customCategories) {
      const row = document.createElement("div");
      row.className = "custom-category-row";
      const label = document.createElement("span");
      label.textContent = category;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "text-button";
      remove.textContent = "Remove";
      remove.addEventListener("click", () => removeCustomCategory(category));
      row.append(label, remove);
      saved.append(row);
    }
    elements.custom_category_list.replaceChildren(saved);
    const existing = new Set(
      [...elements.category_filters.querySelectorAll("[data-filter]")].map((button) => button.dataset.filter),
    );
    for (const button of elements.category_filters.querySelectorAll("[data-custom-filter]")) {
      if (!state.customCategories.includes(button.dataset.filter)) button.remove();
    }
    for (const category of state.customCategories) {
      if (existing.has(category)) continue;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "filter-tab";
      button.dataset.filter = category;
      button.dataset.customFilter = "true";
      button.textContent = category;
      elements.category_filters.append(button);
    }
    for (const button of elements.category_filters.querySelectorAll("[data-filter]")) {
      button.classList.toggle("active", button.dataset.filter === state.filter);
      button.setAttribute("aria-pressed", String(button.dataset.filter === state.filter));
    }
  }

  function addCustomCategory() {
    const category = elements.custom_category.value.trim();
    if (!category) {
      showToast("Enter a label first.", true);
      return;
    }
    if (["All", "People", "Pets", "No motion", "Other motion"].some((item) =>
      item.toLowerCase() === category.toLowerCase(),
    ) || state.customCategories.some((item) => item.toLowerCase() === category.toLowerCase())) {
      showToast("That label already exists.", true);
      return;
    }
    state.customCategories.push(category);
    try {
      saveStoredJson(CATEGORY_STORAGE_KEY, state.customCategories);
    } catch (error) {
      state.customCategories.pop();
      showToast(error.message, true);
      return;
    }
    elements.custom_category.value = "";
    renderCustomCategories();
    showToast(`Added the ${category} label.`);
  }

  function addRegion() {
    if (state.regions.length >= REGION_LIMIT) {
      showToast(`You can add up to ${REGION_LIMIT} regions per source.`, true);
      return;
    }
    state.regions.push({
      id: crypto.randomUUID(),
      name: `Region ${state.regions.length + 1}`,
      x: 0.2,
      y: 0.2,
      width: 0.6,
      height: 0.6,
      enabled: true,
    });
    persistRegions();
  }

  function removeCustomCategory(category) {
    const previous = state.customCategories;
    state.customCategories = previous.filter((item) => item !== category);
    try {
      saveStoredJson(CATEGORY_STORAGE_KEY, state.customCategories);
      if (state.filter === category) state.filter = "All";
      renderCustomCategories();
      renderResults();
    } catch (error) {
      state.customCategories = previous;
      showToast(error.message, true);
    }
  }

  function changedRegions(previous, current) {
    if (!previous || previous.length !== current.length) return [];
    return state.regions.filter((region) => region.enabled).filter((region) => {
      const left = Math.floor(region.x * GRID_WIDTH);
      const right = Math.ceil((region.x + region.width) * GRID_WIDTH);
      const top = Math.floor(region.y * GRID_HEIGHT);
      const bottom = Math.ceil((region.y + region.height) * GRID_HEIGHT);
      let changed = 0;
      let differenceTotal = 0;
      let total = 0;
      for (let y = top; y < bottom; y++) {
        for (let x = left; x < right; x++) {
          const index = y * GRID_WIDTH + x;
          const difference = Math.abs(current[index] - previous[index]);
          total++;
          differenceTotal += difference;
          if (difference >= CHANGE_THRESHOLD) changed++;
        }
      }
      return total > 0 && changed / total >= CHANGED_RATIO &&
        differenceTotal / total >= AVERAGE_CHANGE;
    }).map((region) => region.name);
  }

  async function loadResults() {
    const values = await transact("readonly", (store) => store.getAll());
    state.results = values.sort((first, second) => second.createdAt - first.createdAt).slice(0, MAX_EVENTS);
    renderResults();
  }

  async function saveEvent(event) {
    const saved = await transact("readwrite", (store) => store.add(event));
    await pruneOldEvents();
    await loadResults();
    return saved;
  }

  async function pruneOldEvents() {
    const all = await transact("readonly", (store) => store.getAllKeys());
    if (all.length <= MAX_EVENTS) return;
    const oldestFirst = [...state.results].sort((first, second) => first.createdAt - second.createdAt);
    const removeCount = all.length - MAX_EVENTS;
    const removeIds = oldestFirst.slice(0, removeCount).map((event) => event.id);
    if (removeIds.length) {
      await new Promise((resolve, reject) => {
        const transaction = state.db.transaction(STORE, "readwrite");
        const store = transaction.objectStore(STORE);
        for (const id of removeIds) store.delete(id);
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error || new Error("Couldn't limit saved results."));
        transaction.onabort = () => reject(transaction.error || new Error("Couldn't limit saved results."));
      });
    }
  }

  function renderResults() {
    for (const url of state.previewUrls || []) URL.revokeObjectURL(url);
    state.previewUrls = [];
    const people = state.results.filter((event) => event.category === "People").length;
    const pets = state.results.filter((event) => event.category === "Pets").length;
    elements.stat_total.textContent = String(state.results.length);
    elements.stat_people.textContent = String(people);
    elements.stat_pets.textContent = String(pets);
    elements.nav_count.textContent = String(state.results.length);
    elements.filter_all_count.textContent = String(state.results.length);
    elements.clear_history.hidden = state.results.length === 0;

    const visible = state.filter === "All"
      ? state.results
      : state.results.filter((event) => event.category === state.filter);
    if (visible.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      const illustration = document.createElement("span");
      illustration.className = "empty-illustration";
      illustration.innerHTML = '<svg viewBox="0 0 58 58" fill="none" aria-hidden="true"><circle cx="29" cy="29" r="25" stroke="currentColor" stroke-width="1.5" stroke-dasharray="3 4"/><path d="M15 30h7l4-9 7 17 4-8h6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      const title = document.createElement("strong");
      title.textContent = state.filter === "All" ? "It's nice and quiet." : `No ${state.filter.toLowerCase()} events yet`;
      const message = document.createElement("span");
      message.textContent = state.filter === "All"
        ? "Your motion events will show up here."
        : "Try another filter or analyze a video.";
      empty.append(illustration, title, message);
      elements.activity_list.replaceChildren(empty);
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const event of visible) fragment.append(makeEventCard(event));
    elements.activity_list.replaceChildren(fragment);
  }

  function makeEventCard(event) {
    const card = document.createElement("article");
    card.className = "activity-item";

    const thumbnail = document.createElement("span");
    thumbnail.className = "activity-thumb";
    if (event.thumbnail) {
      const image = document.createElement("img");
      image.src = event.thumbnail;
      image.alt = `Preview from ${event.title}`;
      image.loading = "lazy";
      thumbnail.append(image);
    } else {
      thumbnail.innerHTML = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3 12h5l2.2-5 3.6 10 2-5H21"/></svg>';
    }

    const info = document.createElement("div");
    info.className = "activity-info";
    const title = document.createElement("strong");
    title.textContent = event.title;
    const time = document.createElement("span");
    time.className = "activity-meta";
    time.textContent = `${formatDate(event.createdAt)} · ${event.source === "camera" ? "Live camera" : `${event.samples} samples`}`;
    const report = document.createElement("span");
    report.className = "activity-report";
    report.textContent = event.report || `${event.samples} motion samples recorded.`;
    info.append(title, time, report);

    const right = document.createElement("div");
    right.className = "activity-tags";
    const category = document.createElement("select");
    category.className = `event-category ${categoryClass(event.category)}`;
    category.setAttribute("aria-label", `Activity label for ${event.title}`);
    const labels = new Set([
      "People", "Pets", "Other motion", "No motion", "Image reference", "Recording",
      ...state.customCategories, event.category,
    ]);
    for (const label of labels) {
      const option = document.createElement("option");
      option.value = label;
      option.textContent = label;
      category.append(option);
    }
    category.value = [...category.options].some((option) => option.value === event.category)
      ? event.category
      : "Other motion";
    category.addEventListener("change", async () => {
      try {
        await updateEventCategory(event, category.value);
        await loadResults();
      } catch (error) {
        showToast(`Couldn't update the activity label: ${error.message}`, true);
      }
    });
    right.append(category);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "delete-event";
    remove.title = "Delete this event";
    remove.setAttribute("aria-label", `Delete ${event.title}`);
    remove.innerHTML = '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M4.5 6h11m-9.5 0 .7 10h6.6l.7-10M8 6V4h4v2m-2 2.5v5m-2-5v5m4-5v5"/></svg>';
    remove.addEventListener("click", async () => {
      try {
        await transact("readwrite", (store) => store.delete(event.id));
        await loadResults();
      } catch (error) {
        showToast(`Couldn't delete that event: ${error.message}`, true);
      }
    });
    right.append(remove);
    card.append(thumbnail, info, right);
    if (event.clip instanceof Blob) {
      const clipUrl = URL.createObjectURL(event.clip);
      state.previewUrls.push(clipUrl);
      const clip = document.createElement("details");
      clip.className = "activity-clip";
      const summary = document.createElement("summary");
      summary.textContent = `Play saved clip (${formatBytes(event.clip.size)})`;
      const player = document.createElement("video");
      player.controls = true;
      player.preload = "none";
      player.src = clipUrl;
      player.setAttribute("aria-label", `Saved video for ${event.title}`);
      const download = document.createElement("a");
      download.href = clipUrl;
      download.download = `motion-organizer-${event.id}.webm`;
      download.textContent = "Download clip";
      clip.append(summary, player, download);
      card.append(clip);
    }
    return card;
  }

  function categoryClass(category) {
    if (category === "People") return "tag-people";
    if (category === "Pets") return "tag-pets";
    if (category === "No motion") return "tag-none";
    return "tag-motion";
  }

  function videoReport(intervals, duration) {
    if (intervals.length === 0) {
      return `No motion detected in enabled regions during ${formatDuration(duration)} of footage.`;
    }
    const regionNames = [...new Set(intervals.flatMap((interval) => interval.regions))];
    const summary = intervals.length === 1
      ? `Motion detected from ${formatDuration(intervals[0].start)} to ${formatDuration(intervals[0].end)}`
      : `Motion detected in ${intervals.length} separate periods`;
    const locations = regionNames.length ? ` in ${regionNames.join(", ")}` : "";
    const samples = intervals.reduce((total, interval) => total + interval.samples, 0);
    return `${summary}${locations}. ${samples} motion samples across ${formatDuration(duration)} of footage.`;
  }

  async function updateEventCategory(event, category) {
    await new Promise((resolve, reject) => {
      const transaction = state.db.transaction(STORE, "readwrite");
      const store = transaction.objectStore(STORE);
      const request = store.get(event.id);
      request.onsuccess = () => {
        if (!request.result) {
          transaction.abort();
          reject(new Error("This activity entry no longer exists."));
          return;
        }
        store.put({ ...request.result, category });
      };
      request.onerror = () => reject(request.error || new Error("Couldn't read the saved activity entry."));
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error("Couldn't update the activity label."));
      transaction.onabort = () => reject(transaction.error || new Error("Couldn't update the activity label."));
    });
  }

  function formatDate(timestamp) {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(timestamp));
  }

  function showToast(message, isError = false) {
    window.clearTimeout(state.toastTimer);
    elements.toast.textContent = message;
    elements.toast.classList.toggle("error", isError);
    elements.toast.classList.add("visible");
    state.toastTimer = window.setTimeout(() => elements.toast.classList.remove("visible"), 3800);
  }

  function categoryForMotion() {
    return state.category === "auto" ? "Other motion" : state.category;
  }

  function updateCategory() {
    state.category = elements.category_choice.value;
    elements.activity_footnote.textContent = state.category === "auto"
      ? "Reports describe observed motion and quiet periods; they do not determine intent or identify people."
      : `New motion reports will be labeled ${state.category}. Labels organize events; they do not identify objects.`;
  }

  function captureFrame(video, canvas) {
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("This browser cannot read video frames from its canvas.");
    context.drawImage(video, 0, 0, GRID_WIDTH, GRID_HEIGHT);
    return context.getImageData(0, 0, GRID_WIDTH, GRID_HEIGHT).data;
  }

  function toLuma(pixels) {
    const gray = new Uint8Array(GRID_WIDTH * GRID_HEIGHT);
    for (let source = 0, destination = 0; destination < gray.length; source += 4, destination++) {
      gray[destination] = Math.round(
        (pixels[source] * 299 + pixels[source + 1] * 587 + pixels[source + 2] * 114) / 1000,
      );
    }
    return gray;
  }

  function thumbnailFromCanvas(canvas) {
    return canvas.toDataURL("image/jpeg", 0.64);
  }

  function waitForSeek(video, time, signal) {
    if (signal.aborted) return Promise.reject(new DOMException("Analysis cancelled.", "AbortError"));
    if (Math.abs(video.currentTime - time) < 0.01 && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        video.removeEventListener("seeked", onSeeked);
        video.removeEventListener("error", onError);
        window.clearTimeout(timeout);
        signal.removeEventListener("abort", onAbort);
      };
      const onSeeked = () => { cleanup(); resolve(); };
      const onError = () => { cleanup(); reject(new Error("The browser couldn't read this video frame.")); };
      const onAbort = () => { cleanup(); reject(new DOMException("Analysis cancelled.", "AbortError")); };
      const timeout = window.setTimeout(() => {
        cleanup();
        reject(new Error("This video took too long to seek to a frame. Try a different video."));
      }, 12_000);
      video.addEventListener("seeked", onSeeked, { once: true });
      video.addEventListener("error", onError, { once: true });
      signal.addEventListener("abort", onAbort, { once: true });
      video.currentTime = time;
    });
  }

  function yieldToBrowser() {
    return new Promise((resolve) => window.setTimeout(resolve, 0));
  }

  function waitForVideoReady(video) {
    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        cleanup();
        reject(new Error("The browser couldn't read this video's duration. Try another format."));
      }, 20_000);
      const cleanup = () => {
        video.removeEventListener("loadedmetadata", onReady);
        video.removeEventListener("error", onError);
        window.clearTimeout(timeout);
      };
      const onReady = () => { cleanup(); resolve(); };
      const onError = () => { cleanup(); reject(new Error("The browser couldn't open that video. Try MP4 or MOV.")); };
      video.addEventListener("loadedmetadata", onReady, { once: true });
      video.addEventListener("error", onError, { once: true });
    });
  }

  async function chooseVideoFile(file) {
    if (!file) return;
    if (file.type.startsWith("image/")) {
      await stopCamera();
      try {
        const bitmap = await createImageBitmap(file);
        const canvas = document.createElement("canvas");
        canvas.width = 256;
        canvas.height = 144;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("This browser can't prepare a local image preview.");
        const scale = Math.min(canvas.width / bitmap.width, canvas.height / bitmap.height);
        const width = Math.round(bitmap.width * scale);
        const height = Math.round(bitmap.height * scale);
        context.drawImage(bitmap, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
        bitmap.close();
        await saveEvent({
          title: file.name,
          category: "Image reference",
          source: "image",
          samples: 0,
          thumbnail: canvas.toDataURL("image/jpeg", 0.72),
          report: `Static image added for review (${formatBytes(file.size)}). A single image cannot establish motion or an activity pattern.`,
          createdAt: Date.now(),
        });
        showToast(`Saved ${file.name} as a local image reference.`);
      } catch (error) {
        showToast(`Couldn't add image ${file.name}: ${error.message}`, true);
      }
      return;
    }
    if (!file.type.startsWith("video/") && !/\.(mp4|mov|webm|mkv|avi|m4v|3gp)$/i.test(file.name)) {
      showToast("Choose a video file to analyze.", true);
      return;
    }
    if (!Number.isFinite(file.size) || file.size === 0) {
      showToast("That file is empty. Choose another video.", true);
      return;
    }
    await stopCamera();
    if (state.selectedObjectUrl) URL.revokeObjectURL(state.selectedObjectUrl);
    state.selectedFile = file;
    state.selectedObjectUrl = URL.createObjectURL(file);
    elements.preview.pause();
    elements.preview.srcObject = null;
    elements.preview.src = state.selectedObjectUrl;
    elements.preview.hidden = false;
    elements.stage_empty.hidden = true;
    elements.live_badge.hidden = true;
    elements.region_layer.hidden = false;
    elements.media_status.textContent = `${file.name} · ${formatBytes(file.size)}`;
    elements.stop_camera.hidden = true;
    try {
      await waitForVideoReady(elements.preview);
      if (elements.preview.videoWidth === 0 || elements.preview.videoHeight === 0) {
        throw new Error("That video has no readable picture. Try another file.");
      }
      showToast("Video ready. Starting motion analysis on this device.");
      await analyzeVideo();
    } catch (error) {
      showToast(error.message || "Couldn't open that video.", true);
    }
  }

  async function analyzeVideo() {
    if (!state.selectedFile || !elements.preview.duration) {
      showToast("Choose a video before starting analysis.", true);
      return;
    }
    await stopCamera();
    if (!state.regions.some((region) => region.enabled)) {
      showToast("Enable at least one detection region before analyzing a video.", true);
      return;
    }
    const video = elements.preview;
    const duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0) {
      showToast("Couldn't determine this video's duration.", true);
      return;
    }

    const controller = new AbortController();
    state.analysisController = controller;
    const { signal } = controller;
    const canvas = document.createElement("canvas");
    canvas.width = GRID_WIDTH;
    canvas.height = GRID_HEIGHT;
    const samples = Math.ceil(duration / SAMPLE_INTERVAL_SECONDS);
    let previous = null;
    let motionSamples = 0;
    let thumbnail = null;
    const intervals = [];
    let activeInterval = null;

    elements.analysis_box.hidden = false;
    elements.analysis_progress.value = 0;
    elements.analysis_percent.textContent = "0%";
    elements.analysis_message.textContent = `Scanning ${state.selectedFile.name}`;
    elements.cancel_analysis.disabled = false;
    elements.media_status.textContent = `Sampling ${formatDuration(duration)} of video`;

    try {
      for (let index = 0; index < samples; index++) {
        if (signal.aborted) throw new DOMException("Analysis cancelled.", "AbortError");
        const time = Math.min(index * SAMPLE_INTERVAL_SECONDS, Math.max(0, duration - 0.03));
        await waitForSeek(video, time, signal);
        const current = toLuma(captureFrame(video, canvas));
        const regions = changedRegions(previous, current);
        if (regions.length > 0) {
          motionSamples++;
          if (thumbnail === null) thumbnail = thumbnailFromCanvas(canvas);
          if (!activeInterval) {
            activeInterval = { start: time, end: time, samples: 0, regions: new Set() };
          }
          activeInterval.end = time;
          activeInterval.samples++;
          regions.forEach((region) => activeInterval.regions.add(region));
        } else if (activeInterval) {
          intervals.push({
            ...activeInterval,
            regions: [...activeInterval.regions],
          });
          activeInterval = null;
        }
        previous = current;

        const percent = Math.min(100, Math.round(((index + 1) / samples) * 100));
        elements.analysis_progress.value = percent;
        elements.analysis_percent.textContent = `${percent}%`;
        if (index % 10 === 0) {
          elements.analysis_message.textContent = `Scanning ${state.selectedFile.name} · ${formatDuration(time)}`;
          await yieldToBrowser();
        }
      }

      if (activeInterval) {
        intervals.push({
          ...activeInterval,
          end: duration,
          regions: [...activeInterval.regions],
        });
      }
      const category = motionSamples === 0 ? "No motion" : categoryForMotion();
      await saveEvent({
        title: state.selectedFile.name,
        category,
        source: "video",
        samples: motionSamples,
        duration,
        thumbnail,
        report: videoReport(intervals, duration),
        intervals,
        createdAt: Date.now(),
      });
      elements.media_status.textContent = motionSamples === 0
        ? "Analysis complete · no movement found"
        : `Analysis complete · ${intervals.length} activity periods`;
      showToast(motionSamples === 0
        ? "No movement was detected in the enabled regions."
        : `${category} report saved with ${intervals.length} activity periods.`);
    } catch (error) {
      if (error.name === "AbortError") {
        elements.media_status.textContent = "Video analysis cancelled";
        showToast("Video analysis cancelled.");
      } else {
        elements.media_status.textContent = "Could not finish video analysis";
        showToast(`Video analysis failed: ${error.message || "unknown error"}`, true);
      }
    } finally {
      state.analysisController = null;
      elements.analysis_box.hidden = true;
      elements.cancel_analysis.disabled = false;
    }
  }

  function formatBytes(bytes) {
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function formatDuration(seconds) {
    const rounded = Math.floor(seconds);
    const hours = Math.floor(rounded / 3600);
    const minutes = Math.floor((rounded % 3600) / 60);
    const remaining = rounded % 60;
    if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
    return `${minutes}:${String(remaining).padStart(2, "0")}`;
  }

  function createRecorder(stream, onData) {
    if (typeof MediaRecorder === "undefined") {
      throw new Error("Video recording is not supported by this browser.");
    }
    const mimeType = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"]
      .find((type) => MediaRecorder.isTypeSupported(type));
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) onData(event.data);
    });
    return recorder;
  }

  function startRecording() {
    state.recordingMode = elements.recording_mode.value;
    if (state.recordingMode !== "continuous") return;
    startContinuousSegment();
  }

  function startContinuousSegment() {
    if (!state.stream || state.recordingMode !== "continuous") return;
    try {
      state.continuousChunks = [];
      state.continuousRecorder = createRecorder(state.stream, (chunk) => {
        state.continuousChunks.push(chunk);
      });
      state.continuousRecorder.start(1000);
      state.continuousTimer = window.setTimeout(async () => {
        try {
          await finishContinuousSegment();
          startContinuousSegment();
        } catch (error) {
          showToast(`Continuous recording paused: ${error.message}`, true);
        }
      }, 10 * 60 * 1000);
    } catch (error) {
      state.recordingMode = "off";
      elements.recording_mode.value = "off";
      showToast(`Couldn't start continuous recording: ${error.message}`, true);
    }
  }

  function startEventRecording() {
    if (state.recordingMode !== "events" || state.eventRecorder) return;
    try {
      state.eventChunks = [];
      state.eventRecorder = createRecorder(state.stream, (chunk) => {
        state.eventChunks.push(chunk);
      });
      state.eventRecorder.start(1000);
    } catch (error) {
      showToast(`Motion detection is running, but event recording couldn't start: ${error.message}`, true);
    }
  }

  async function stopEventRecording() {
    const recorder = state.eventRecorder;
    if (!recorder) return null;
    const chunks = state.eventChunks;
    state.eventRecorder = null;
    state.eventChunks = [];
    if (recorder.state !== "inactive") {
      await new Promise((resolve, reject) => {
        recorder.addEventListener("stop", resolve, { once: true });
        recorder.addEventListener("error", () => reject(new Error("The event recording stopped unexpectedly.")), { once: true });
        recorder.stop();
      });
    }
    const clip = new Blob(chunks, { type: recorder.mimeType || "video/webm" });
    if (clip.size > 0 && clip.size <= 25 * 1024 * 1024) return clip;
    if (clip.size > 25 * 1024 * 1024) {
      showToast("This event clip exceeded the 25 MB local storage limit and was not saved.", true);
    }
    return null;
  }

  async function finishContinuousSegment() {
    if (state.continuousTimer !== null) {
      window.clearTimeout(state.continuousTimer);
      state.continuousTimer = null;
    }
    const recorder = state.continuousRecorder;
    if (!recorder) return;
    const chunks = state.continuousChunks;
    state.continuousRecorder = null;
    state.continuousChunks = [];
    if (recorder.state !== "inactive") {
      await new Promise((resolve, reject) => {
        recorder.addEventListener("stop", resolve, { once: true });
        recorder.addEventListener("error", () => reject(new Error("Continuous recording stopped unexpectedly.")), { once: true });
        recorder.stop();
      });
    }
    const clip = new Blob(chunks, { type: recorder.mimeType || "video/webm" });
    if (clip.size > 0) {
      await saveEvent({
        title: "Continuous camera recording",
        category: "Recording",
        source: "camera-recording",
        samples: 0,
        report: `Continuous camera recording · ${formatBytes(clip.size)} · ${formatDate(Date.now())}. Saved only on this device.`,
        clip,
        createdAt: Date.now(),
      });
    }
  }

  async function stopRecording() {
    try {
      await finishContinuousSegment();
    } catch (error) {
      showToast(`Couldn't save continuous recording: ${error.message}`, true);
    }
    await stopEventRecording();
  }

  async function startCamera() {
    if (state.analysisController) {
      showToast("Cancel the current video analysis before starting the camera.", true);
      return;
    }
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
      showToast("Camera access requires HTTPS or the Windows app. Run the website on localhost or a secure website.", true);
      return;
    }
    if (!state.regions.some((region) => region.enabled)) {
      showToast("Enable at least one detection region before starting the camera.", true);
      return;
    }
    if (elements.notifications_enabled.checked && "Notification" in window &&
      Notification.permission === "default") {
      try {
        await Notification.requestPermission();
      } catch (error) {
        showToast(`Couldn't request notification permission: ${error.message}`, true);
      }
    }
    await stopCamera();
    if (state.selectedObjectUrl) {
      URL.revokeObjectURL(state.selectedObjectUrl);
      state.selectedObjectUrl = null;
    }
    state.selectedFile = null;
    state.previousFrame = null;
    state.lastMotionAt = Date.now();
    state.lastQuietReportAt = 0;
    state.cameraMotion = null;

    try {
      state.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
        audio: false,
      });
      elements.preview.pause();
      elements.preview.removeAttribute("src");
      elements.preview.srcObject = state.stream;
      elements.preview.hidden = false;
      elements.stage_empty.hidden = true;
      elements.region_layer.hidden = false;
      elements.live_badge.hidden = false;
      elements.stop_camera.hidden = false;
      elements.media_status.textContent = "Camera is live · watching for movement";
      await elements.preview.play();
      state.cameraTimer = window.setInterval(analyzeCameraFrame, CAMERA_SAMPLE_MS);
      startRecording();
      elements.media_status.textContent = `Camera is live · ${state.recordingMode === "off"
        ? "watching without recording"
        : state.recordingMode === "continuous"
          ? "continuous recording"
          : "saving motion event clips"}`;
      showToast("Camera is live. Analysis and recordings stay on this device.");
    } catch (error) {
      await stopCamera();
      const message = error.name === "NotAllowedError"
        ? "Camera permission is blocked. Allow camera access in your browser or Windows settings."
        : error.name === "NotFoundError"
          ? "No camera was found on this device."
          : error.message || "Couldn't start the camera.";
      elements.media_status.textContent = "Camera not connected";
      showToast(message, true);
    }
  }

  async function analyzeCameraFrame() {
    if (!state.stream || elements.preview.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    try {
      const canvas = document.createElement("canvas");
      canvas.width = GRID_WIDTH;
      canvas.height = GRID_HEIGHT;
      const current = toLuma(captureFrame(elements.preview, canvas));
      const regions = changedRegions(state.previousFrame, current);
      state.previousFrame = current;
      const now = Date.now();
      if (regions.length === 0) {
        await finishQuietCameraEvent(now);
        await reportQuietPeriod(now);
        return;
      }
      if (state.cameraMotion && now - state.cameraMotion.lastMotionAt > CAMERA_EVENT_GAP_MS) {
        await saveCameraMotionEvent(state.cameraMotion);
        state.cameraMotion = null;
      }
      if (!state.cameraMotion) {
        state.cameraMotion = {
          startAt: now,
          lastMotionAt: now,
          samples: 0,
          regions: new Set(),
          thumbnail: thumbnailFromCanvas(canvas),
        };
        startEventRecording();
      }
      state.cameraMotion.lastMotionAt = now;
      state.cameraMotion.samples++;
      regions.forEach((region) => state.cameraMotion.regions.add(region));
      state.lastMotionAt = now;
      state.lastQuietReportAt = 0;
      elements.media_status.textContent =
        `Movement detected · ${[...state.cameraMotion.regions].join(", ")}`;
    } catch (error) {
      await stopCamera();
      elements.media_status.textContent = "Camera analysis stopped";
      showToast(`Camera analysis failed: ${error.message || "unknown error"}`, true);
    }
  }

  async function finishQuietCameraEvent(now) {
    if (!state.cameraMotion || now - state.cameraMotion.lastMotionAt < CAMERA_EVENT_GAP_MS) return;
    const motion = state.cameraMotion;
    state.cameraMotion = null;
    await saveCameraMotionEvent(motion);
  }

  async function saveCameraMotionEvent(motion) {
    const regions = [...motion.regions];
    const clip = await stopEventRecording();
    const durationSeconds = Math.max(0, Math.round((motion.lastMotionAt - motion.startAt) / 1000));
    const report = `Motion was detected ${motion.samples} times over ${formatDuration(durationSeconds)} in ${regions.join(", ") || "enabled regions"} (${formatDate(motion.startAt)}–${formatDate(motion.lastMotionAt)}).`;
    await saveEvent({
      title: "Live camera motion",
      category: categoryForMotion(),
      source: "camera",
      samples: motion.samples,
      regions,
      report,
      clip,
      thumbnail: motion.thumbnail,
      createdAt: motion.startAt,
    });
    if (elements.notifications_enabled.checked && "Notification" in window &&
      Notification.permission === "granted") {
      new Notification("Motion Organizer: movement detected", {
        body: `${regions.join(", ") || "Enabled regions"} · ${formatDate(motion.startAt)}`,
        tag: "motion-organizer-motion",
      });
    }
    elements.media_status.textContent = `Movement report saved · ${regions.join(", ")}`;
  }

  async function reportQuietPeriod(now) {
    const quietDuration = Number(elements.quiet_period.value) * 1000;
    if (!Number.isFinite(quietDuration) || now - state.lastMotionAt < quietDuration ||
      (state.lastQuietReportAt && now - state.lastQuietReportAt < quietDuration)) {
      return;
    }
    const end = now;
    const start = state.lastMotionAt;
    state.lastQuietReportAt = now;
    await saveEvent({
      title: "Quiet period",
      category: "No motion",
      source: "camera",
      samples: 0,
      regions: state.regions.filter((region) => region.enabled).map((region) => region.name),
      report: `No motion was detected in enabled regions from ${formatDate(start)} to ${formatDate(end)}. This report describes sampled frames only.`,
      createdAt: end,
    });
    elements.media_status.textContent = "No motion detected in enabled regions";
  }

  async function stopCamera() {
    if (state.cameraTimer !== null) {
      window.clearInterval(state.cameraTimer);
      state.cameraTimer = null;
    }
    if (state.cameraMotion) {
      const motion = state.cameraMotion;
      state.cameraMotion = null;
      try {
        await saveCameraMotionEvent(motion);
      } catch (error) {
        showToast(`Couldn't save the final motion report: ${error.message}`, true);
      }
    }
    try {
      await stopRecording();
    } catch (error) {
      showToast(`Couldn't finish the event recording: ${error.message}`, true);
    }
    if (state.stream) {
      for (const track of state.stream.getTracks()) track.stop();
      state.stream = null;
    }
    state.previousFrame = null;
    if (elements.preview.srcObject) {
      elements.preview.pause();
      elements.preview.srcObject = null;
      elements.preview.removeAttribute("src");
      elements.preview.hidden = true;
    }
    elements.live_badge.hidden = true;
    elements.region_layer.hidden = !state.selectedFile;
    elements.stop_camera.hidden = true;
    if (state.selectedFile && state.selectedObjectUrl) {
      elements.preview.src = state.selectedObjectUrl;
      elements.preview.hidden = false;
    } else {
      elements.stage_empty.hidden = false;
      elements.preview.hidden = true;
    }
  }

  function setupInstallPrompt() {
    window.addEventListener("beforeinstallprompt", (event) => {
      event.preventDefault();
      state.deferredInstallPrompt = event;
      elements.install_button.hidden = false;
    });
    window.addEventListener("appinstalled", () => {
      state.deferredInstallPrompt = null;
      elements.install_button.hidden = true;
      showToast("Motion Organizer has been installed.");
    });
    elements.install_button.addEventListener("click", async () => {
      if (!state.deferredInstallPrompt) {
        showToast("Use your browser's Install app or Add to Home Screen menu.");
        return;
      }
      state.deferredInstallPrompt.prompt();
      await state.deferredInstallPrompt.userChoice;
      state.deferredInstallPrompt = null;
      elements.install_button.hidden = true;
    });
  }

  function setupServiceWorker() {
    if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js").catch((error) => {
        console.warn("Motion Organizer offline caching is unavailable.", error);
      });
    }, { once: true });
  }

  function setupEvents() {
    window.addEventListener("online", renderConnectionStatus);
    window.addEventListener("offline", renderConnectionStatus);
    elements.export_backup.addEventListener("click", exportReports);
    elements.import_backup.addEventListener("click", () => elements.backup_input.click());
    elements.backup_input.addEventListener("change", async () => {
      const file = elements.backup_input.files?.[0];
      elements.backup_input.value = "";
      await importReports(file);
    });
    elements.pick_video.addEventListener("click", () => elements.video_input.click());
    elements.pick_video_nav.addEventListener("click", () => elements.video_input.click());
    elements.video_input.addEventListener("change", async () => {
      const files = elements.video_input.files ? [...elements.video_input.files] : [];
      elements.video_input.value = "";
      if (files.length > 10) showToast(`Added ${files.length} files. Videos are analyzed one at a time.`, false);
      for (const file of files) {
        await chooseVideoFile(file);
      }
    });
    elements.start_camera.addEventListener("click", startCamera);
    elements.stop_camera.addEventListener("click", () => {
      stopCamera();
      elements.media_status.textContent = "Live camera stopped";
      showToast("Camera monitoring stopped.");
    });
    elements.cancel_analysis.addEventListener("click", () => {
      if (state.analysisController) {
        elements.cancel_analysis.disabled = true;
        state.analysisController.abort();
      }
    });
    elements.category_choice.addEventListener("change", updateCategory);
    elements.add_region.addEventListener("click", addRegion);
    elements.save_category.addEventListener("click", addCustomCategory);
    elements.custom_category.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        addCustomCategory();
      }
    });
    elements.recording_mode.addEventListener("change", () => {
      try {
        localStorage.setItem("motion-organizer-recording-mode", elements.recording_mode.value);
        showToast("Recording mode saved. Stop and restart monitoring to apply it.");
      } catch (error) {
        showToast(`Couldn't save recording mode: ${error.message}`, true);
      }
    });
    elements.notifications_enabled.addEventListener("change", () => {
      try {
        localStorage.setItem("motion-organizer-notifications", String(elements.notifications_enabled.checked));
      } catch (error) {
        showToast(`Couldn't save notification settings: ${error.message}`, true);
      }
    });
    elements.quiet_period.addEventListener("change", () => {
      try {
        localStorage.setItem("motion-organizer-quiet-period", elements.quiet_period.value);
      } catch (error) {
        showToast(`Couldn't save quiet-period setting: ${error.message}`, true);
      }
    });
    elements.category_filters.addEventListener("click", (event) => {
      const button = event.target.closest("[data-filter]");
      if (!button) return;
      state.filter = button.dataset.filter;
      for (const tab of elements.category_filters.querySelectorAll(".filter-tab")) {
        tab.classList.toggle("active", tab === button);
        tab.setAttribute("aria-pressed", String(tab === button));
      }
      renderResults();
    });
    elements.clear_history.addEventListener("click", async () => {
      const approved = typeof window.confirm !== "function" ||
        window.confirm("Delete all saved activity from this device? This cannot be undone.");
      if (!approved) return;
      try {
        await transact("readwrite", (store) => store.clear());
        await loadResults();
        showToast("All saved activity has been deleted.");
      } catch (error) {
        showToast(`Couldn't clear saved activity: ${error.message}`, true);
      }
    });
    elements.preview.addEventListener("error", () => {
      if (!state.stream && state.selectedFile) {
        elements.media_status.textContent = "Video preview could not be played";
      }
    });
  }

  async function initialize() {
    collectElements();
    elements.platform_label.textContent = window.motionOrganizer?.isDesktop
      ? "WINDOWS EDITION"
      : "WEB EDITION";
    setupInstallPrompt();
    setupServiceWorker();
    renderConnectionStatus();

    if (window.motionOrganizer?.isDesktop) {
      elements.install_button.hidden = true;
    }

    state.db = await openDatabase();
    loadMonitorSettings();
    updateCategory();
    await loadResults();
    setupEvents();
  }

  window.addEventListener("DOMContentLoaded", () => {
    initialize().catch((error) => {
      console.error("Motion Organizer could not start.", error);
      showToast(`Couldn't start the app: ${error.message}`, true);
    });
  }, { once: true });
})();

try {
  const savedState = JSON.parse(localStorage.getItem("pay-on-time:v1"));
  if (savedState?.settings?.theme === "dark") document.documentElement.dataset.theme = "dark";
} catch (error) {
  // Повреждённые данные будут обработаны после загрузки страницы.
}

(function () {
  "use strict";

  const STORAGE_KEY = "pay-on-time:v1";
  const SCHEMA_VERSION = 1;
  const MAX_AMOUNT_KOPECKS = 99999999999;
  const PAGE_SIZE = 25;
  const CATEGORIES = {
    utilities: "ЖКХ", electricity: "Электричество", internet: "Интернет", phone: "Телефон",
    credits: "Кредиты", subscriptions: "Подписки", other: "Другое"
  };

  let state = null;
  let storageAvailable = true;
  let toastTimer = null;
  let formContext = null;
  let initialFormSignature = "";
  let choiceResolver = null;
  let confirmResolver = null;
  let activeTab = "today";
  let currentPage = 1;
  let dayCurrentPage = 1;
  let selectedMonthKey = "";
  let selectedDateKey = "";
  const modalOpeners = new WeakMap();
  const modalStack = [];
  const FOCUSABLE_SELECTOR = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

  function pad2(value) { return String(value).padStart(2, "0"); }
  function toDateKey(date) { return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`; }
  function parseDateKey(dateKey) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateKey))) return null;
    const [year, month, day] = dateKey.split("-").map(Number);
    const date = new Date(year, month - 1, day);
    return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
  }
  function isValidDateKey(dateKey) { return Boolean(parseDateKey(dateKey)); }
  function addDays(date, days) {
    const result = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    result.setDate(result.getDate() + days);
    return result;
  }
  function getMonthKey(dateKey) { return String(dateKey).slice(0, 7); }
  function shiftMonthKey(key, offset) {
    const [year, month] = key.split("-").map(Number);
    const shifted = new Date(year, month - 1 + offset, 1);
    return `${shifted.getFullYear()}-${pad2(shifted.getMonth() + 1)}`;
  }
  function dateForTargetDay(key, targetDay) {
    const [year, month] = key.split("-").map(Number);
    const lastDay = new Date(year, month, 0).getDate();
    return `${key}-${pad2(Math.min(targetDay, lastDay))}`;
  }
  function formatDate(dateKey) {
    const date = parseDateKey(dateKey);
    if (!date) return "Некорректная дата";
    return new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" }).format(date);
  }
  function formatLongDate(date) {
    return new Intl.DateTimeFormat("ru-RU", { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(date);
  }
  function formatMonthYear(date) {
    const formatted = new Intl.DateTimeFormat("ru-RU", { month: "long", year: "numeric" }).format(date).replace(/\s*г\.$/u, "");
    return formatted.charAt(0).toUpperCase() + formatted.slice(1);
  }
  function formatMoney(amountKopecks) {
    return new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amountKopecks / 100);
  }
  function normalizeAmount(value) {
    const compact = String(value).trim().replace(/[\s\u00a0\u202f]/g, "");
    if (!/^\d{1,9}(?:[.,]\d{1,2})?$/.test(compact)) return { valid: false, value: null };
    const amount = Number(compact.replace(",", "."));
    const amountKopecks = Math.round(amount * 100);
    return Number.isFinite(amount) && amountKopecks > 0 && amountKopecks <= MAX_AMOUNT_KOPECKS
      ? { valid: true, value: amountKopecks }
      : { valid: false, value: null };
  }

  function collectIds(targetState) { return new Set([...targetState.items, ...targetState.series].map((entry) => entry.id)); }
  function makeId(existingIds) {
    let candidate = "";
    do {
      const now = Date.now().toString(36);
      const precise = typeof performance !== "undefined" && typeof performance.now === "function" ? Math.floor(performance.now() * 1000).toString(36) : "0";
      candidate = `${now}-${precise}-${Math.random().toString(36).slice(2, 11)}`;
    } while (existingIds.has(candidate));
    existingIds.add(candidate);
    return candidate;
  }
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function createEmptyState() {
    return {
      schemaVersion: SCHEMA_VERSION, initialized: true,
      settings: { theme: "light", defaultReminderDays: 3, storageNoticeDismissed: false },
      items: [], series: []
    };
  }
  function createDemoState(today) {
    const result = createEmptyState();
    const ids = new Set();
    const createdAt = new Date().toISOString();
    result.items.push({
      id: makeId(ids), kind: "payment", title: "Оплатить интернет", category: "internet", amountKopecks: 90000,
      date: toDateKey(today), reminderDays: 3, note: "", completedAt: null, createdAt, updatedAt: createdAt
    });
    const electricityDate = addDays(today, 3);
    result.series.push({
      id: makeId(ids), kind: "payment", frequency: "monthly", title: "Оплатить электричество", category: "electricity",
      amountKopecks: 150000, startDate: toDateKey(electricityDate), targetDay: electricityDate.getDate(), endDate: null,
      reminderDays: 3, note: "", occurrenceOverrides: {}, createdAt, updatedAt: createdAt
    });
    result.items.push({
      id: makeId(ids), kind: "task", title: "Передать показания счётчиков", date: toDateKey(addDays(today, 1)),
      reminderDays: 1, note: "", completedAt: null, createdAt, updatedAt: createdAt
    });
    result.items.push({
      id: makeId(ids), kind: "payment", title: "Мобильная связь", category: "phone", amountKopecks: 65000,
      date: toDateKey(addDays(today, -2)), reminderDays: 1, note: "", completedAt: createdAt, createdAt, updatedAt: createdAt
    });
    return result;
  }
  function isPlainObject(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
  function isValidTimestamp(value, allowNull = false) {
    return (allowNull && value === null) || (typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value)));
  }
  function isValidText(value, maximum, allowEmpty = false) {
    return typeof value === "string" && value.length <= maximum && (allowEmpty || value.trim().length > 0);
  }
  function isValidPaymentFields(value) {
    return isValidText(value.title, 100) && Object.hasOwn(CATEGORIES, value.category)
      && Number.isInteger(value.amountKopecks) && value.amountKopecks > 0 && value.amountKopecks <= MAX_AMOUNT_KOPECKS
      && [1, 3].includes(value.reminderDays) && isValidText(value.note, 500, true);
  }
  function isUsableItem(item) {
    if (!isPlainObject(item) || typeof item.id !== "string" || !["payment", "task"].includes(item.kind)
      || !isValidText(item.title, 100) || !isValidDateKey(item.date) || ![1, 3].includes(item.reminderDays)
      || !isValidText(item.note, 500, true) || !isValidTimestamp(item.completedAt, true)
      || !isValidTimestamp(item.createdAt) || !isValidTimestamp(item.updatedAt)) return false;
    return item.kind === "task" || (Object.hasOwn(CATEGORIES, item.category)
      && Number.isInteger(item.amountKopecks) && item.amountKopecks > 0 && item.amountKopecks <= MAX_AMOUNT_KOPECKS);
  }
  function isUsableOverride(override) {
    if (!isPlainObject(override) || (Object.hasOwn(override, "deleted") && override.deleted !== true)) return false;
    if (Object.hasOwn(override, "title") && !isValidText(override.title, 100)) return false;
    if (Object.hasOwn(override, "category") && !Object.hasOwn(CATEGORIES, override.category)) return false;
    if (Object.hasOwn(override, "amountKopecks") && (!Number.isInteger(override.amountKopecks) || override.amountKopecks <= 0 || override.amountKopecks > MAX_AMOUNT_KOPECKS)) return false;
    if (Object.hasOwn(override, "date") && !isValidDateKey(override.date)) return false;
    if (Object.hasOwn(override, "reminderDays") && ![1, 3].includes(override.reminderDays)) return false;
    if (Object.hasOwn(override, "note") && !isValidText(override.note, 500, true)) return false;
    if (Object.hasOwn(override, "completedAt")) {
      if (!isValidTimestamp(override.completedAt) || !isPlainObject(override.snapshot) || !isValidPaymentFields(override.snapshot) || !isValidDateKey(override.snapshot.date)) return false;
    }
    return true;
  }
  function isUsableSeries(series) {
    if (!isPlainObject(series) || typeof series.id !== "string" || series.kind !== "payment" || series.frequency !== "monthly"
      || !isValidPaymentFields(series) || !isValidDateKey(series.startDate) || !Number.isInteger(series.targetDay)
      || series.targetDay < 1 || series.targetDay > 31 || parseDateKey(series.startDate).getDate() !== series.targetDay
      || !(series.endDate === null || (isValidDateKey(series.endDate) && series.endDate >= series.startDate))
      || !isPlainObject(series.occurrenceOverrides) || !isValidTimestamp(series.createdAt) || !isValidTimestamp(series.updatedAt)) return false;
    return true;
  }
  function sanitizeState(value) {
    const clean = clone(value), usedIds = new Set();
    let skipped = 0;
    clean.items = clean.items.filter((item) => {
      const valid = isUsableItem(item) && !usedIds.has(item.id);
      if (valid) usedIds.add(item.id); else skipped += 1;
      return valid;
    });
    clean.series = clean.series.filter((series) => {
      const valid = isUsableSeries(series) && !usedIds.has(series.id);
      if (valid) usedIds.add(series.id); else skipped += 1;
      return valid;
    });
    for (const series of clean.series) {
      for (const [key, override] of Object.entries(series.occurrenceOverrides)) {
        if (!/^\d{4}-\d{2}$/.test(key) || !isUsableOverride(override)) {
          delete series.occurrenceOverrides[key];
          skipped += 1;
        }
      }
    }
    return { value: clean, skipped };
  }
  function isValidState(value) {
    return isPlainObject(value) && value.schemaVersion === SCHEMA_VERSION && value.initialized === true
      && isPlainObject(value.settings) && ["light", "dark"].includes(value.settings.theme)
      && [1, 3].includes(value.settings.defaultReminderDays) && typeof value.settings.storageNoticeDismissed === "boolean"
      && Array.isArray(value.items) && Array.isArray(value.series);
  }

  function readRawStorage() {
    try { return localStorage.getItem(STORAGE_KEY); }
    catch (error) { storageAvailable = false; return null; }
  }
  function writeState(nextState, successMessage) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(nextState));
      storageAvailable = true;
      hideStorageError();
      if (successMessage) showToast(successMessage);
      return true;
    } catch (error) {
      storageAvailable = false;
      const message = error?.name === "QuotaExceededError"
        ? "Недостаточно места в хранилище браузера. Последние изменения не сохранены."
        : "Доступ к хранилищу браузера запрещён. Последние изменения не сохранены.";
      showStorageError(message);
      return false;
    }
  }
  function removeBrokenStorage() {
    try { localStorage.removeItem(STORAGE_KEY); }
    catch (error) { storageAvailable = false; }
  }
  function loadState(today) {
    const raw = readRawStorage();
    if (raw === null) {
      const initial = createDemoState(today);
      writeState(initial);
      return { value: initial, recoveryMessage: "" };
    }
    try {
      const parsed = JSON.parse(raw);
      if (!isValidState(parsed)) throw new Error("Unsupported storage structure");
      const sanitized = sanitizeState(parsed);
      if (sanitized.skipped > 0) {
        writeState(sanitized.value);
        return { value: sanitized.value, recoveryMessage: "Некоторые повреждённые записи были пропущены" };
      }
      return { value: sanitized.value, recoveryMessage: "" };
    } catch (error) {
      removeBrokenStorage();
      const empty = createEmptyState();
      writeState(empty);
      return { value: empty, recoveryMessage: "Сохранённые данные были повреждены и сброшены" };
    }
  }
  function commit(mutator, successMessage) {
    let nextState;
    try {
      nextState = clone(state);
      mutator(nextState);
    } catch (error) {
      showStorageError("Не удалось выполнить действие. Сохранённые данные не изменены.");
      return false;
    }
    if (!writeState(nextState, successMessage)) return false;
    state = nextState;
    render(new Date());
    return true;
  }

  function getOccurrence(series, occurrenceKey) {
    if (occurrenceKey < getMonthKey(series.startDate)) return null;
    const override = series.occurrenceOverrides[occurrenceKey] || {};
    if (override.deleted) return null;
    const baseDate = dateForTargetDay(occurrenceKey, series.targetDay);
    if (series.endDate && baseDate > series.endDate) return null;
    if (override.completedAt && override.snapshot) {
      return {
        ...override.snapshot, id: `${series.id}:${occurrenceKey}`, kind: "payment", frequency: "monthly",
        seriesId: series.id, occurrenceKey, completedAt: override.completedAt
      };
    }
    return {
      id: `${series.id}:${occurrenceKey}`, kind: "payment", frequency: "monthly", seriesId: series.id, occurrenceKey,
      title: override.title ?? series.title, category: override.category ?? series.category,
      amountKopecks: override.amountKopecks ?? series.amountKopecks, date: override.date ?? baseDate,
      reminderDays: override.reminderDays ?? series.reminderDays, note: override.note ?? series.note,
      completedAt: override.completedAt ?? null
    };
  }
  function getRelevantOccurrence(series, today) {
    const startKey = getMonthKey(series.startDate);
    const currentKey = getMonthKey(toDateKey(today));
    let key = currentKey < startKey ? startKey : currentKey;
    let fallback = null;
    const limit = Object.keys(series.occurrenceOverrides).length + 24;
    for (let offset = 0; offset < limit; offset += 1) {
      const occurrence = getOccurrence(series, key);
      if (occurrence && !occurrence.completedAt) return occurrence;
      if (occurrence && !fallback) fallback = occurrence;
      if (series.endDate && key >= getMonthKey(series.endDate)) break;
      key = shiftMonthKey(key, 1);
    }
    return fallback || getOccurrence(series, series.endDate ? getMonthKey(series.endDate) : startKey);
  }
  function getNextFutureOccurrence(series, todayKey) {
    const startKey = getMonthKey(series.startDate);
    let key = getMonthKey(todayKey) < startKey ? startKey : getMonthKey(todayKey);
    const limit = Object.keys(series.occurrenceOverrides).length + 24;
    for (let offset = 0; offset < limit; offset += 1) {
      const occurrence = getOccurrence(series, key);
      if (occurrence && !occurrence.completedAt && occurrence.date >= todayKey) return occurrence;
      if (series.endDate && key >= getMonthKey(series.endDate)) break;
      key = shiftMonthKey(key, 1);
    }
    return null;
  }
  function getMonthKeysBetween(startDateKey, endDateKey) {
    const keys = [];
    let key = getMonthKey(startDateKey);
    const endKey = getMonthKey(endDateKey);
    while (key <= endKey) {
      keys.push(key);
      key = shiftMonthKey(key, 1);
    }
    return keys;
  }
  function getRecordsInRange(targetState, startDateKey, endDateKey) {
    const items = targetState.items.filter((item) => item.date >= startDateKey && item.date <= endDateKey);
    const occurrences = [];
    for (const series of targetState.series) {
      const candidateKeys = new Set(getMonthKeysBetween(startDateKey, endDateKey));
      for (const [key, override] of Object.entries(series.occurrenceOverrides)) {
        const effectiveDate = override.snapshot?.date || override.date;
        if (effectiveDate && effectiveDate >= startDateKey && effectiveDate <= endDateKey) candidateKeys.add(key);
      }
      for (const key of candidateKeys) {
        const occurrence = getOccurrence(series, key);
        if (occurrence && occurrence.date >= startDateKey && occurrence.date <= endDateKey) occurrences.push(occurrence);
      }
    }
    return [...items, ...occurrences];
  }
  function getOverdueRecords(targetState, todayKey) {
    const records = targetState.items.filter((item) => !item.completedAt && item.date < todayKey);
    for (const series of targetState.series) {
      const firstKey = getMonthKey(series.startDate);
      const lastKey = getMonthKey(todayKey);
      const visited = new Set();
      let key = firstKey;
      while (key <= lastKey) {
        visited.add(key);
        const occurrence = getOccurrence(series, key);
        if (occurrence && !occurrence.completedAt && occurrence.date < todayKey) records.push(occurrence);
        key = shiftMonthKey(key, 1);
      }
      for (const overrideKey of Object.keys(series.occurrenceOverrides)) {
        if (visited.has(overrideKey)) continue;
        const occurrence = getOccurrence(series, overrideKey);
        if (occurrence && !occurrence.completedAt && occurrence.date < todayKey) records.push(occurrence);
      }
    }
    return records;
  }
  function getCompletedRecords(targetState, today) {
    const cutoff = new Date(today.getFullYear() - 1, today.getMonth(), today.getDate());
    const cutoffKey = toDateKey(cutoff);
    const isWithinHistory = (completedAt) => completedAt && toDateKey(new Date(completedAt)) >= cutoffKey;
    const records = targetState.items.filter((item) => isWithinHistory(item.completedAt));
    for (const series of targetState.series) {
      for (const key of Object.keys(series.occurrenceOverrides)) {
        const occurrence = getOccurrence(series, key);
        if (occurrence?.completedAt && isWithinHistory(occurrence.completedAt)) records.push(occurrence);
      }
    }
    return records;
  }
  function getWarningState(record, todayKey) {
    if (record.completedAt || record.date < todayKey) return false;
    const date = parseDateKey(record.date);
    const warningStart = toDateKey(addDays(date, -record.reminderDays));
    return todayKey >= warningStart && todayKey <= record.date;
  }
  function sortRecords(records, completedFirst = false) {
    const collator = new Intl.Collator("ru-RU");
    return records.sort((a, b) => {
      if (completedFirst && Boolean(a.completedAt) !== Boolean(b.completedAt)) return a.completedAt ? 1 : -1;
      const dateResult = a.date.localeCompare(b.date);
      if (dateResult) return dateResult;
      if (a.kind !== b.kind) return a.kind === "payment" ? -1 : 1;
      return collator.compare(a.title, b.title);
    });
  }
  function getAllManagementRecords(today) {
    const todayKey = toDateKey(today);
    const items = state.items.map((item) => ({ ...item, managementSource: "item", hasFutureDate: item.date >= todayKey }));
    const seriesRows = state.series.map((series) => {
      const nearest = getRelevantOccurrence(series, today);
      const nextFuture = getNextFutureOccurrence(series, todayKey);
      return {
        ...series,
        date: nearest?.date || series.startDate,
        completedAt: null,
        managementSource: "series-master",
        seriesId: series.id,
        seriesMaster: true,
        hasFutureDate: Boolean(nextFuture)
      };
    });
    const collator = new Intl.Collator("ru-RU");
    return [...items, ...seriesRows].sort((a, b) => {
      if (a.hasFutureDate !== b.hasFutureDate) return a.hasFutureDate ? -1 : 1;
      const dateResult = a.date.localeCompare(b.date);
      if (dateResult) return dateResult;
      if (a.kind !== b.kind) return a.kind === "payment" ? -1 : 1;
      return collator.compare(a.title, b.title);
    });
  }
  function getViewRecords(today) {
    const todayKey = toDateKey(today);
    if (activeTab === "today") return sortRecords(getRecordsInRange(state, todayKey, todayKey), true);
    if (activeTab === "upcoming") {
      const start = toDateKey(addDays(today, 1));
      const end = toDateKey(addDays(today, 7));
      return sortRecords(getRecordsInRange(state, start, end).filter((record) => !record.completedAt));
    }
    if (activeTab === "overdue") return sortRecords(getOverdueRecords(state, todayKey));
    if (activeTab === "completed") return getCompletedRecords(state, today).sort((a, b) => b.completedAt.localeCompare(a.completedAt));
    return getAllManagementRecords(today);
  }
  function getStatus(record, todayKey) {
    if (record.completedAt) return "completed";
    return record.date < todayKey ? "overdue" : "planned";
  }

  function buildItem(data, ids, now) {
    const item = {
      id: makeId(ids), kind: data.kind, title: data.title, date: data.date, reminderDays: data.reminderDays,
      note: data.note, completedAt: null, createdAt: now, updatedAt: now
    };
    if (data.kind === "payment") { item.category = data.category; item.amountKopecks = data.amountKopecks; }
    return item;
  }
  function buildSeries(data, ids, now) {
    return {
      id: makeId(ids), kind: "payment", frequency: "monthly", title: data.title, category: data.category,
      amountKopecks: data.amountKopecks, startDate: data.date, targetDay: parseDateKey(data.date).getDate(),
      endDate: data.endDate || null, reminderDays: data.reminderDays, note: data.note,
      occurrenceOverrides: {}, createdAt: now, updatedAt: now
    };
  }
  function cleanOverride(series, key) {
    const override = series.occurrenceOverrides[key];
    if (!override) return;
    for (const field of ["title", "category", "amountKopecks", "reminderDays", "note"]) {
      if (override[field] === series[field]) delete override[field];
    }
    if (override.date === dateForTargetDay(key, series.targetDay)) delete override.date;
    if (Object.keys(override).length === 0) delete series.occurrenceOverrides[key];
  }
  function hasCompletedMonthOutsideRange(series, startDate, endDate) {
    const startKey = getMonthKey(startDate);
    return Object.entries(series.occurrenceOverrides).some(([key, override]) => {
      if (!override.completedAt) return false;
      const completedDate = override.snapshot?.date || dateForTargetDay(key, series.targetDay);
      return key < startKey || Boolean(endDate && completedDate > endDate);
    });
  }
  function applyFormMutation(targetState, context, data, now) {
    const ids = collectIds(targetState);
    if (context.mode === "add" || context.mode === "duplicate") {
      if (data.kind === "payment" && data.frequency === "monthly") targetState.series.push(buildSeries(data, ids, now));
      else targetState.items.push(buildItem(data, ids, now));
      targetState.settings.defaultReminderDays = data.reminderDays;
      return;
    }
    if (context.sourceType === "item") {
      const item = targetState.items.find((entry) => entry.id === context.id);
      if (!item) throw new Error("Запись не найдена");
      Object.assign(item, { title: data.title, date: data.date, reminderDays: data.reminderDays, note: data.note, updatedAt: now });
      if (item.kind === "payment") Object.assign(item, { category: data.category, amountKopecks: data.amountKopecks });
    } else {
      const series = targetState.series.find((entry) => entry.id === context.seriesId);
      if (!series) throw new Error("Серия не найдена");
      if (context.scope === "single") {
        const override = series.occurrenceOverrides[context.occurrenceKey] || {};
        const changedFields = {
          title: data.title, category: data.category, amountKopecks: data.amountKopecks,
          date: data.date, reminderDays: data.reminderDays, note: data.note
        };
        Object.assign(override, changedFields);
        if (override.completedAt && override.snapshot) Object.assign(override.snapshot, changedFields);
        series.occurrenceOverrides[context.occurrenceKey] = override;
        cleanOverride(series, context.occurrenceKey);
      } else {
        Object.assign(series, {
          title: data.title, category: data.category, amountKopecks: data.amountKopecks, startDate: data.date,
          targetDay: parseDateKey(data.date).getDate(), endDate: data.endDate || null,
          reminderDays: data.reminderDays, note: data.note
        });
        for (const key of Object.keys(series.occurrenceOverrides)) cleanOverride(series, key);
      }
      series.updatedAt = now;
    }
    targetState.settings.defaultReminderDays = data.reminderDays;
  }
  function toggleCompletion(targetState, reference, now) {
    if (reference.sourceType === "item") {
      const item = targetState.items.find((entry) => entry.id === reference.id);
      if (!item) throw new Error("Запись не найдена");
      item.completedAt = item.completedAt ? null : now;
      item.updatedAt = now;
      return;
    }
    const series = targetState.series.find((entry) => entry.id === reference.seriesId);
    if (!series) throw new Error("Серия не найдена");
    const occurrence = getOccurrence(series, reference.occurrenceKey);
    if (!occurrence) throw new Error("Платёж не найден");
    const override = series.occurrenceOverrides[reference.occurrenceKey] || {};
    if (override.completedAt) {
      if (override.snapshot) {
        Object.assign(override, {
          title: override.snapshot.title, category: override.snapshot.category,
          amountKopecks: override.snapshot.amountKopecks, date: override.snapshot.date,
          reminderDays: override.snapshot.reminderDays, note: override.snapshot.note
        });
      }
      delete override.completedAt;
      delete override.snapshot;
    }
    else {
      override.completedAt = now;
      override.snapshot = {
        title: occurrence.title, category: occurrence.category, amountKopecks: occurrence.amountKopecks,
        date: occurrence.date, reminderDays: occurrence.reminderDays, note: occurrence.note
      };
    }
    series.occurrenceOverrides[reference.occurrenceKey] = override;
    cleanOverride(series, reference.occurrenceKey);
    series.updatedAt = now;
  }
  function deleteRecord(targetState, reference, scope) {
    if (reference.sourceType === "item") {
      targetState.items = targetState.items.filter((entry) => entry.id !== reference.id);
      return;
    }
    const series = targetState.series.find((entry) => entry.id === reference.seriesId);
    if (!series) throw new Error("Серия не найдена");
    if (scope === "all") targetState.series = targetState.series.filter((entry) => entry.id !== reference.seriesId);
    else series.occurrenceOverrides[reference.occurrenceKey] = { deleted: true };
  }

  function applyTheme(theme) {
    const isDark = theme === "dark";
    document.documentElement.dataset.theme = isDark ? "dark" : "light";
    document.getElementById("themeToggle").setAttribute("aria-label", isDark ? "Включить светлую тему" : "Включить тёмную тему");
    document.getElementById("themeText").textContent = isDark ? "Светлая тема" : "Тёмная тема";
    document.getElementById("themeIcon").textContent = isDark ? "☀" : "◐";
  }
  function showStorageError(message) {
    document.getElementById("storageErrorText").textContent = message;
    document.getElementById("storageError").hidden = false;
  }
  function hideStorageError() { document.getElementById("storageError").hidden = true; }
  function showToast(message) {
    const toast = document.getElementById("toast");
    window.clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.add("is-visible");
    toastTimer = window.setTimeout(() => toast.classList.remove("is-visible"), 2400);
  }
  function getFocusableElements(dialog) {
    return Array.from(dialog.querySelectorAll(FOCUSABLE_SELECTOR)).filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true" && element.getClientRects().length > 0);
  }
  function openModal(dialog, initialFocus = null) {
    modalOpeners.set(dialog, document.activeElement instanceof HTMLElement ? document.activeElement : null);
    modalStack.push(dialog);
    dialog.showModal();
    window.requestAnimationFrame(() => {
      const target = initialFocus || getFocusableElements(dialog)[0] || dialog;
      target.focus();
    });
  }
  function closeModal(dialog) {
    if (!dialog.open) return;
    const opener = modalOpeners.get(dialog);
    dialog.close();
    const index = modalStack.lastIndexOf(dialog);
    if (index >= 0) modalStack.splice(index, 1);
    window.queueMicrotask(() => {
      const activeDialog = modalStack[modalStack.length - 1];
      if (opener?.isConnected && (!activeDialog || activeDialog.contains(opener))) opener.focus();
    });
  }
  function trapModalFocus(event) {
    if (event.key !== "Tab") return;
    const dialog = modalStack[modalStack.length - 1];
    if (!dialog?.open) return;
    const focusable = getFocusableElements(dialog);
    if (!focusable.length) { event.preventDefault(); dialog.focus(); return; }
    const first = focusable[0], last = focusable[focusable.length - 1];
    const activeIndex = focusable.indexOf(document.activeElement);
    if (event.shiftKey && activeIndex <= 0) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && (activeIndex === -1 || document.activeElement === last)) {
      event.preventDefault(); first.focus();
    }
  }
  function pluralizeRecords(count) {
    const mod10 = count % 10, mod100 = count % 100;
    if (mod10 === 1 && mod100 !== 11) return `${count} запись`;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${count} записи`;
    return `${count} записей`;
  }
  function createActionButton(label, action, reference, extraClass = "") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `record-action ${extraClass}`.trim();
    button.textContent = label;
    Object.assign(button.dataset, { action, sourceType: reference.sourceType });
    if (reference.id) button.dataset.id = reference.id;
    if (reference.seriesId) button.dataset.seriesId = reference.seriesId;
    if (reference.occurrenceKey) button.dataset.occurrenceKey = reference.occurrenceKey;
    return button;
  }
  function createRecordElement(record, todayKey) {
    const reference = record.seriesMaster
      ? { sourceType: "series-master", seriesId: record.seriesId }
      : record.seriesId
        ? { sourceType: "series", seriesId: record.seriesId, occurrenceKey: record.occurrenceKey }
        : { sourceType: "item", id: record.id };
    const status = record.seriesMaster ? "planned" : getStatus(record, todayKey);
    const warning = !record.seriesMaster && getWarningState(record, todayKey);
    const article = document.createElement("article");
    article.className = `record-card${status === "completed" ? " is-complete" : ""}`;

    const summaryRow = document.createElement("div");
    summaryRow.className = "record-summary-row";
    const symbol = document.createElement("span");
    symbol.className = "record-symbol";
    symbol.setAttribute("aria-hidden", "true");
    symbol.textContent = record.kind === "task" ? "✓" : "₽";
    const primary = document.createElement("div");
    primary.className = "record-primary";
    const title = document.createElement("p");
    title.className = "record-title";
    title.textContent = record.title;
    const badge = document.createElement("span");
    badge.className = `status-badge${status === "overdue" ? " is-overdue" : status === "completed" ? " is-complete" : ""}`;
    badge.textContent = record.seriesMaster ? "Ежемесячно" : warning ? "Срок близко" : status === "completed" ? "Выполнено" : status === "overdue" ? "Просрочено" : "Запланировано";
    if (warning) badge.classList.add("is-warning");
    primary.append(title, badge);

    const facts = document.createElement("div");
    facts.className = "record-facts";
    const date = document.createElement("span");
    date.className = "record-date";
    date.textContent = formatDate(record.date);
    facts.append(date);
    if (record.kind === "payment") {
      const amount = document.createElement("span");
      amount.className = "record-amount";
      amount.textContent = formatMoney(record.amountKopecks);
      facts.append(amount);
    }

    if (!record.seriesMaster) {
      const quick = createActionButton(status === "completed" ? "Вернуть" : "Выполнено", "toggle", reference, "record-quick-complete");
      summaryRow.append(symbol, primary, facts, quick);
    } else {
      const placeholder = document.createElement("span");
      placeholder.className = "record-quick-placeholder";
      placeholder.setAttribute("aria-hidden", "true");
      summaryRow.append(symbol, primary, facts, placeholder);
    }

    const detailsId = `details-${record.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
    const expand = document.createElement("button");
    expand.type = "button";
    expand.className = "record-expand";
    expand.dataset.action = "expand";
    expand.setAttribute("aria-expanded", "false");
    expand.setAttribute("aria-controls", detailsId);
    expand.setAttribute("aria-label", `Показать подробности: ${record.title}`);
    expand.textContent = "⌄";
    summaryRow.append(expand);

    const details = document.createElement("div");
    details.className = "record-details";
    details.id = detailsId;
    details.hidden = true;
    const list = document.createElement("dl");
    list.className = "record-details-grid";
    function addDetail(label, value) {
      const wrapper = document.createElement("div");
      const term = document.createElement("dt");
      const description = document.createElement("dd");
      term.textContent = label;
      description.textContent = value;
      wrapper.append(term, description);
      list.append(wrapper);
    }
    addDetail("Дата", formatDate(record.date));
    addDetail("Тип", record.kind === "task" ? "Задача" : CATEGORIES[record.category] || "Платёж");
    if (record.kind === "payment") addDetail("Сумма", formatMoney(record.amountKopecks));
    addDetail("Повторение", record.frequency === "monthly" ? `Ежемесячно${record.endDate ? ` до ${formatDate(record.endDate)}` : " · без окончания"}` : "Нет");
    if (!record.seriesMaster) addDetail("Напоминание", `За ${record.reminderDays} ${record.reminderDays === 1 ? "день" : "дня"}`);
    if (record.note) addDetail("Примечание", record.note);
    const actions = document.createElement("div");
    actions.className = "record-actions";
    actions.append(
      createActionButton("Изменить", "edit", reference),
      createActionButton("Дублировать", "duplicate", reference),
      createActionButton("Удалить", "delete", reference, "record-action-delete")
    );
    details.append(list, actions);
    article.append(summaryRow, details);
    return article;
  }
  function renderRecords(today) {
    const records = getViewRecords(today);
    const list = document.getElementById("recordList");
    const totalPages = Math.max(1, Math.ceil(records.length / PAGE_SIZE));
    currentPage = Math.min(currentPage, totalPages);
    const startIndex = (currentPage - 1) * PAGE_SIZE;
    const pageRecords = records.slice(startIndex, startIndex + PAGE_SIZE);
    if (records.length === 0) {
      const messages = {
        today: "На сегодня ничего не запланировано",
        upcoming: "На ближайшие 7 дней записей нет",
        overdue: "Просроченных записей нет",
        completed: "За последние 12 месяцев выполненных записей нет",
        all: "Записей пока нет"
      };
      const empty = document.createElement("div");
      empty.className = "empty-state";
      const text = document.createElement("p");
      text.textContent = messages[activeTab];
      const button = document.createElement("button"); button.type = "button"; button.className = "primary-button"; button.textContent = "Добавить запись";
      button.addEventListener("click", openAddForm); empty.append(text, button); list.replaceChildren(empty);
    } else list.replaceChildren(...pageRecords.map((record) => createRecordElement(record, toDateKey(today))));
    document.getElementById("recordCount").textContent = pluralizeRecords(records.length);
    const titles = { today: "Сегодня", upcoming: "Ближайшие 7 дней", overdue: "Просроченные", completed: "Выполненные", all: "Все записи" };
    document.getElementById("recordsTitle").textContent = titles[activeTab];
    document.querySelectorAll(".tab").forEach((tab) => {
      const selected = tab.dataset.tab === activeTab;
      tab.classList.toggle("is-active", selected);
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      if (selected) document.getElementById("recordList").setAttribute("aria-labelledby", tab.id);
    });
    const pagination = document.getElementById("pagination");
    pagination.hidden = records.length <= PAGE_SIZE;
    document.getElementById("pageStatus").textContent = `Страница ${currentPage} из ${totalPages}`;
    document.getElementById("pagePrevious").disabled = currentPage <= 1;
    document.getElementById("pageNext").disabled = currentPage >= totalPages;
  }
  function renderCalendar(today) {
    const [year, monthNumber] = selectedMonthKey.split("-").map(Number);
    const month = monthNumber - 1;
    const monthDate = new Date(year, month, 1);
    document.getElementById("calendarTitle").textContent = formatMonthYear(monthDate);
    const firstDay = monthDate;
    const daysInMonth = new Date(year, month + 1, 0).getDate(), mondayOffset = (firstDay.getDay() + 6) % 7, cells = [];
    const monthStart = `${selectedMonthKey}-01`;
    const monthEnd = dateForTargetDay(selectedMonthKey, 31);
    const monthRecords = getRecordsInRange(state, monthStart, monthEnd);
    for (let index = 0; index < mondayOffset; index += 1) {
      const spacer = document.createElement("span"); spacer.className = "calendar-spacer"; spacer.setAttribute("aria-hidden", "true"); cells.push(spacer);
    }
    for (let day = 1; day <= daysInMonth; day += 1) {
      const dateKey = `${selectedMonthKey}-${pad2(day)}`;
      const dayItems = monthRecords.filter((record) => record.date === dateKey);
      const cell = document.createElement("button");
      const isToday = dateKey === toDateKey(today);
      cell.type = "button";
      cell.className = `calendar-day${isToday ? " is-today" : ""}${dateKey === selectedDateKey ? " is-selected" : ""}`;
      cell.dataset.date = dateKey;
      cell.tabIndex = dateKey === selectedDateKey ? 0 : -1;
      cell.setAttribute("aria-pressed", String(dateKey === selectedDateKey));
      const number = document.createElement("span");
      number.textContent = String(day);
      cell.append(number);
      const statusCounts = { overdue: 0, warning: 0, planned: 0, completed: 0 };
      for (const record of dayItems) {
        const status = getStatus(record, toDateKey(today));
        if (status === "planned" && getWarningState(record, toDateKey(today))) statusCounts.warning += 1;
        else statusCounts[status] += 1;
      }
      const indicators = document.createElement("span");
      indicators.className = "calendar-indicators";
      for (const status of ["overdue", "warning", "planned", "completed"].filter((name) => statusCounts[name] > 0).slice(0, 3)) {
        const dot = document.createElement("span");
        dot.className = `calendar-dot ${status}`;
        dot.setAttribute("aria-hidden", "true");
        indicators.append(dot);
      }
      cell.append(indicators);
      if (dayItems.length) {
        const count = document.createElement("span");
        count.className = "calendar-count";
        count.textContent = String(dayItems.length);
        cell.append(count);
      }
      const statusLabels = { overdue: "просрочено", warning: "срок близко", planned: "запланировано", completed: "выполнено" };
      const description = Object.entries(statusCounts).filter(([, count]) => count).map(([name, count]) => `${statusLabels[name]}: ${count}`).join(", ");
      cell.setAttribute("aria-label", `${formatLongDate(new Date(year, month, day))}${dayItems.length ? `, записей: ${dayItems.length}, ${description}` : ", записей нет"}`);
      if (isToday) cell.setAttribute("aria-current", "date");
      cells.push(cell);
    }
    document.getElementById("calendarGrid").replaceChildren(...cells);
    renderSelectedDay(today);
  }
  function renderSelectedDay(today) {
    const records = sortRecords(getRecordsInRange(state, selectedDateKey, selectedDateKey));
    const totalPages = Math.max(1, Math.ceil(records.length / PAGE_SIZE));
    dayCurrentPage = Math.min(dayCurrentPage, totalPages);
    const startIndex = (dayCurrentPage - 1) * PAGE_SIZE;
    const pageRecords = records.slice(startIndex, startIndex + PAGE_SIZE);
    document.getElementById("selectedDayTitle").textContent = formatDate(selectedDateKey);
    const container = document.getElementById("dayRecords");
    const pagination = document.getElementById("dayPagination");
    pagination.hidden = records.length <= PAGE_SIZE;
    document.getElementById("dayPageStatus").textContent = `Страница ${dayCurrentPage} из ${totalPages}`;
    document.getElementById("dayPagePrevious").disabled = dayCurrentPage <= 1;
    document.getElementById("dayPageNext").disabled = dayCurrentPage >= totalPages;
    if (!records.length) {
      const empty = document.createElement("p");
      empty.className = "calendar-hint";
      empty.textContent = "На этот день записей нет";
      container.replaceChildren(empty);
      return;
    }
    container.replaceChildren(...pageRecords.map((record) => {
      const row = document.createElement("div");
      row.className = "day-record";
      const name = document.createElement("span");
      name.textContent = record.title;
      const value = document.createElement("span");
      const status = getStatus(record, toDateKey(today));
      const statusText = status === "completed" ? "Выполнено" : status === "overdue" ? "Просрочено" : getWarningState(record, toDateKey(today)) ? "Срок близко" : "Запланировано";
      value.textContent = record.kind === "payment" ? `${formatMoney(record.amountKopecks)} · ${statusText}` : statusText;
      row.append(name, value);
      return row;
    }));
  }
  function calculateSummary(today) {
    const monthStart = `${selectedMonthKey}-01`;
    const monthEnd = dateForTargetDay(selectedMonthKey, 31);
    const monthPayments = getRecordsInRange(state, monthStart, monthEnd).filter((record) => record.kind === "payment");
    const overduePayments = getOverdueRecords(state, toDateKey(today)).filter((record) => record.kind === "payment");
    const upcomingPayments = getRecordsInRange(state, toDateKey(today), toDateKey(addDays(today, 6)))
      .filter((record) => record.kind === "payment" && !record.completedAt);
    const sum = (records) => records.reduce((total, record) => total + record.amountKopecks, 0);
    return {
      planned: sum(monthPayments),
      paid: sum(monthPayments.filter((record) => record.completedAt)),
      remaining: sum(monthPayments.filter((record) => !record.completedAt)),
      overdue: sum(overduePayments),
      upcoming: sum(upcomingPayments)
    };
  }
  function renderSummary(today) {
    const summary = calculateSummary(today);
    document.getElementById("summaryPlanned").textContent = formatMoney(summary.planned);
    document.getElementById("summaryPaid").textContent = formatMoney(summary.paid);
    document.getElementById("summaryRemaining").textContent = formatMoney(summary.remaining);
    document.getElementById("summaryOverdue").textContent = formatMoney(summary.overdue);
    document.getElementById("summaryUpcoming").textContent = formatMoney(summary.upcoming);
    const monthName = formatMonthYear(parseDateKey(`${selectedMonthKey}-01`));
    document.getElementById("summaryTitle").textContent = `Сводка за ${monthName}`;
  }
  function renderReminders(today) {
    const todayKey = toDateKey(today);
    const records = getRecordsInRange(state, todayKey, toDateKey(addDays(today, 3))).filter((record) => getWarningState(record, todayKey));
    document.getElementById("reminderCount").textContent = String(records.length);
    const button = document.getElementById("reminderButton");
    button.classList.toggle("has-reminders", records.length > 0);
    button.setAttribute("aria-label", `Открыть ближайшие предупреждения: ${records.length}`);
  }
  function renderStorageNotice() { document.getElementById("storageNotice").hidden = state.settings.storageNoticeDismissed; }
  function renderStorageStatus() {
    const count = state.items.length + state.series.length;
    document.getElementById("storageStatus").textContent = storageAvailable
      ? `Локальное хранилище работает · версия данных ${state.schemaVersion} · ${pluralizeRecords(count)}`
      : "Хранилище недоступно: изменения сохраняются только до закрытия страницы.";
  }
  function render(today) {
    applyTheme(state.settings.theme); document.getElementById("todayLabel").textContent = formatLongDate(today);
    renderStorageNotice(); renderStorageStatus(); renderRecords(today); renderSummary(today); renderReminders(today); renderCalendar(today);
  }

  function clearErrors() {
    for (const id of ["title", "category", "amount", "date", "endDate", "note"]) {
      const input = document.getElementById(`entry${id[0].toUpperCase()}${id.slice(1)}`), error = document.getElementById(`${id}Error`);
      if (input) input.removeAttribute("aria-invalid");
      if (error) error.textContent = "";
    }
  }
  function setFieldError(field, message) {
    const input = document.getElementById(`entry${field[0].toUpperCase()}${field.slice(1)}`), error = document.getElementById(`${field}Error`);
    if (input) input.setAttribute("aria-invalid", "true");
    if (error) error.textContent = message;
  }
  function clearFieldError(field) {
    const input = document.getElementById(`entry${field[0].toUpperCase()}${field.slice(1)}`), error = document.getElementById(`${field}Error`);
    if (input) input.removeAttribute("aria-invalid");
    if (error) error.textContent = "";
  }
  function validateFieldOnBlur(input) {
    const kind = document.querySelector('input[name="entryKind"]:checked').value;
    if (input.id === "entryTitle") {
      clearFieldError("title");
      const title = input.value.trim();
      if (!title) setFieldError("title", "Введите название");
      else if (title.length > 100) setFieldError("title", "Не более 100 символов");
    } else if (input.id === "entryAmount" && kind === "payment") {
      clearFieldError("amount");
      if (!normalizeAmount(input.value).valid) setFieldError("amount", "Введите сумму больше 0, не более 999 999 999,99 ₽ и до двух знаков после запятой");
    } else if (input.id === "entryDate") {
      clearFieldError("date");
      if (!isValidDateKey(input.value)) setFieldError("date", "Укажите корректную дату");
    } else if (input.id === "entryEndDate") {
      clearFieldError("endDate");
      const monthly = kind === "payment" && document.getElementById("entryFrequency").value === "monthly";
      if (monthly && input.value && (!isValidDateKey(input.value) || input.value < document.getElementById("entryDate").value)) setFieldError("endDate", "Дата окончания не может быть раньше даты начала");
    } else if (input.id === "entryNote") {
      clearFieldError("note");
      if (input.value.trim().length > 500) setFieldError("note", "Не более 500 символов");
    }
  }
  function updateFormVisibility() {
    const kind = document.querySelector('input[name="entryKind"]:checked').value, isPayment = kind === "payment";
    document.querySelectorAll(".payment-only").forEach((element) => { element.hidden = !isPayment; });
    const monthly = isPayment && document.getElementById("entryFrequency").value === "monthly";
    document.getElementById("endDateField").hidden = !monthly || formContext?.scope === "single";
  }
  function serializeForm() {
    return JSON.stringify({
      kind: document.querySelector('input[name="entryKind"]:checked').value,
      title: document.getElementById("entryTitle").value, category: document.getElementById("entryCategory").value,
      amount: document.getElementById("entryAmount").value, frequency: document.getElementById("entryFrequency").value,
      date: document.getElementById("entryDate").value, endDate: document.getElementById("entryEndDate").value,
      reminderDays: document.getElementById("entryReminder").value, note: document.getElementById("entryNote").value
    });
  }
  function setKind(kind) { document.querySelector(`input[name="entryKind"][value="${kind}"]`).checked = true; }
  function fillForm(record, options = {}) {
    setKind(record?.kind || "payment");
    document.getElementById("entryTitle").value = record?.title || "";
    document.getElementById("entryCategory").value = record?.category || "utilities";
    document.getElementById("entryAmount").value = record?.amountKopecks ? String(record.amountKopecks / 100).replace(".", ",") : "";
    document.getElementById("entryFrequency").value = options.frequency || record?.frequency || "once";
    document.getElementById("entryDate").value = options.date ?? record?.date ?? "";
    document.getElementById("entryEndDate").value = options.endDate || "";
    document.getElementById("entryReminder").value = String(record?.reminderDays || state.settings.defaultReminderDays);
    document.getElementById("entryNote").value = record?.note || "";
    document.getElementById("noteCounter").textContent = String(document.getElementById("entryNote").value.length);
  }
  function setFormLocks(context) {
    document.querySelectorAll('input[name="entryKind"]').forEach((radio) => { radio.disabled = context.mode !== "add"; });
    document.getElementById("entryFrequency").disabled = context.sourceType === "series" || context.mode === "edit";
  }
  function openForm(context, record, options = {}) {
    formContext = context; clearErrors();
    document.getElementById("dialogEyebrow").textContent = context.mode === "edit" ? "Редактирование" : context.mode === "duplicate" ? "Копия записи" : "Новая запись";
    document.getElementById("dialogTitle").textContent = context.mode === "edit" ? "Изменить запись" : context.mode === "duplicate" ? "Дублировать запись" : "Добавить запись";
    document.getElementById("saveEntryButton").textContent = context.mode === "edit" ? "Сохранить" : "Добавить";
    fillForm(record, options); setFormLocks(context); updateFormVisibility(); initialFormSignature = serializeForm();
    openModal(document.getElementById("entryDialog"), document.getElementById("entryTitle"));
  }
  function openAddForm(date = null) { openForm({ mode: "add", sourceType: null }, null, date ? { date } : {}); }
  function attemptCloseForm(force = false) {
    if (!force && serializeForm() !== initialFormSignature && !window.confirm("Закрыть форму и потерять несохранённые изменения?")) return;
    closeModal(document.getElementById("entryDialog")); formContext = null;
  }
  function readAndValidateForm() {
    clearErrors();
    const kind = document.querySelector('input[name="entryKind"]:checked').value;
    const title = document.getElementById("entryTitle").value.trim(), note = document.getElementById("entryNote").value.trim();
    const date = document.getElementById("entryDate").value, endDate = document.getElementById("entryEndDate").value;
    const frequency = kind === "payment" ? document.getElementById("entryFrequency").value : "once";
    const reminderDays = Number(document.getElementById("entryReminder").value);
    let firstInvalid = null;
    function fail(field, message) {
      setFieldError(field, message);
      if (!firstInvalid) firstInvalid = document.getElementById(`entry${field[0].toUpperCase()}${field.slice(1)}`);
    }
    if (!title) fail("title", "Введите название"); else if (title.length > 100) fail("title", "Не более 100 символов");
    if (!isValidDateKey(date)) fail("date", "Укажите корректную дату");
    if (note.length > 500) fail("note", "Не более 500 символов");
    let amountKopecks = null, category = null;
    if (kind === "payment") {
      category = document.getElementById("entryCategory").value;
      if (!Object.hasOwn(CATEGORIES, category)) fail("category", "Выберите категорию");
      const normalized = normalizeAmount(document.getElementById("entryAmount").value);
      if (!normalized.valid) fail("amount", "Введите сумму больше 0, не более 999 999 999,99 ₽ и до двух знаков после запятой");
      else amountKopecks = normalized.value;
      if (frequency === "monthly" && endDate && (!isValidDateKey(endDate) || endDate < date)) fail("endDate", "Дата окончания не может быть раньше даты начала");
    }
    if (formContext?.mode === "edit" && formContext.sourceType === "series" && formContext.scope === "all") {
      const series = state.series.find((entry) => entry.id === formContext.seriesId);
      if (series && isValidDateKey(date) && hasCompletedMonthOutsideRange(series, date, endDate || null)) fail("date", "Новый период не должен исключать уже выполненные платежи серии");
    }
    if (firstInvalid) { firstInvalid.focus(); return null; }
    return { kind, title, note, date, endDate: endDate || null, frequency, reminderDays, category, amountKopecks };
  }

  function askScope(title, message) {
    document.getElementById("choiceTitle").textContent = title; document.getElementById("choiceMessage").textContent = message;
    openModal(document.getElementById("choiceDialog"), document.getElementById("choiceTitle")); return new Promise((resolve) => { choiceResolver = resolve; });
  }
  function finishScope(value) {
    closeModal(document.getElementById("choiceDialog")); const resolve = choiceResolver; choiceResolver = null; if (resolve) resolve(value);
  }
  function askConfirm(message, acceptLabel = "Удалить") {
    document.getElementById("confirmMessage").textContent = message; document.getElementById("confirmAccept").textContent = acceptLabel;
    openModal(document.getElementById("confirmDialog"), document.getElementById("confirmTitle")); return new Promise((resolve) => { confirmResolver = resolve; });
  }
  function finishConfirm(value) {
    closeModal(document.getElementById("confirmDialog")); const resolve = confirmResolver; confirmResolver = null; if (resolve) resolve(value);
  }
  function referenceFromButton(button) {
    return {
      sourceType: button.dataset.sourceType, id: button.dataset.id || null,
      seriesId: button.dataset.seriesId || null, occurrenceKey: button.dataset.occurrenceKey || null
    };
  }
  function getRecordByReference(reference) {
    if (reference.sourceType === "item") return state.items.find((entry) => entry.id === reference.id) || null;
    const series = state.series.find((entry) => entry.id === reference.seriesId);
    if (reference.sourceType === "series-master") {
      const nearest = series ? getRelevantOccurrence(series, new Date()) : null;
      return series ? { ...series, date: nearest?.date || series.startDate, seriesId: series.id, seriesMaster: true } : null;
    }
    return series ? getOccurrence(series, reference.occurrenceKey) : null;
  }
  async function handleRecordAction(button) {
    const action = button.dataset.action;
    if (action === "expand") {
      const card = button.closest(".record-card");
      const details = card.querySelector(".record-details");
      const expanded = button.getAttribute("aria-expanded") === "true";
      button.setAttribute("aria-expanded", String(!expanded));
      button.setAttribute("aria-label", `${expanded ? "Показать" : "Скрыть"} подробности`);
      card.classList.toggle("is-expanded", !expanded);
      details.hidden = expanded;
      return;
    }
    const reference = referenceFromButton(button), record = getRecordByReference(reference);
    if (!record) return;
    if (action === "toggle") {
      commit((next) => toggleCompletion(next, reference, new Date().toISOString()), record.completedAt ? "Запись возвращена в работу" : "Запись выполнена"); return;
    }
    if (action === "duplicate") {
      if (reference.sourceType === "series" || reference.sourceType === "series-master") {
        const series = state.series.find((entry) => entry.id === reference.seriesId);
        openForm({ mode: "duplicate", sourceType: "series" }, { ...series, date: series.startDate }, { frequency: "monthly", endDate: series.endDate || "" });
      } else openForm({ mode: "duplicate", sourceType: "item" }, record, { frequency: "once" });
      return;
    }
    if (action === "edit") {
      if (reference.sourceType === "series-master") {
        const series = state.series.find((entry) => entry.id === reference.seriesId);
        openForm({ mode: "edit", sourceType: "series", seriesId: reference.seriesId, scope: "all" }, { ...series, date: series.startDate }, { frequency: "monthly", endDate: series.endDate || "" });
      } else if (reference.sourceType === "series") {
        const scope = await askScope("Изменить ежемесячный платёж", `Как изменить «${record.title}»?`);
        if (!scope) return;
        if (scope === "single") openForm({ mode: "edit", sourceType: "series", seriesId: reference.seriesId, occurrenceKey: reference.occurrenceKey, scope }, record, { frequency: "monthly" });
        else {
          const series = state.series.find((entry) => entry.id === reference.seriesId);
          openForm({ mode: "edit", sourceType: "series", seriesId: reference.seriesId, occurrenceKey: reference.occurrenceKey, scope }, { ...series, date: series.startDate }, { frequency: "monthly", endDate: series.endDate || "" });
        }
      } else openForm({ mode: "edit", sourceType: "item", id: reference.id }, record, { frequency: "once" });
      return;
    }
    if (action === "delete") {
      if (!await askConfirm(`Удалить «${record.title}»?`)) return;
      let scope = "single";
      if (reference.sourceType === "series-master") scope = "all";
      else if (reference.sourceType === "series") { scope = await askScope("Удалить ежемесячный платёж", `Удалить только выбранный платёж «${record.title}» или всю серию?`); if (!scope) return; }
      commit((next) => deleteRecord(next, reference, scope), scope === "all" ? "Серия удалена" : "Запись удалена");
    }
  }

  function selectTab(tabName) {
    activeTab = tabName;
    currentPage = 1;
    renderRecords(new Date());
  }

  function moveCalendar(offset) {
    selectedMonthKey = shiftMonthKey(selectedMonthKey, offset);
    if (getMonthKey(selectedDateKey) !== selectedMonthKey) selectedDateKey = `${selectedMonthKey}-01`;
    dayCurrentPage = 1;
    render(new Date());
  }

  function selectCalendarDate(dateKey, moveFocus = false) {
    if (dateKey !== selectedDateKey) dayCurrentPage = 1;
    selectedDateKey = dateKey;
    selectedMonthKey = getMonthKey(dateKey);
    render(new Date());
    if (moveFocus) window.requestAnimationFrame(() => document.querySelector(`.calendar-day[data-date="${dateKey}"]`)?.focus());
  }

  function applyEmptyPlanner(successMessage) {
    const empty = createEmptyState();
    if (!writeState(empty, successMessage)) return false;
    state = empty;
    activeTab = "today";
    currentPage = 1;
    dayCurrentPage = 1;
    selectedDateKey = toDateKey(new Date());
    selectedMonthKey = getMonthKey(selectedDateKey);
    render(new Date());
    return true;
  }
  async function resetPlanner() {
    if (!await askConfirm("Начать планировщик заново? Все платежи, задачи, серии и история будут удалены без возможности восстановления.", "Да, начать заново")) return;
    applyEmptyPlanner("Планировщик сброшен");
  }
  async function clearAllData() {
    if (!await askConfirm("Удалить все платежи, задачи, серии и историю? Это действие нельзя отменить.", "Да, удалить всё")) return;
    applyEmptyPlanner("Все данные удалены");
  }

  function bindEvents() {
    document.getElementById("themeToggle").addEventListener("click", () => commit((next) => { next.settings.theme = state.settings.theme === "dark" ? "light" : "dark"; }, "Тема сохранена"));
    document.getElementById("dismissStorageNotice").addEventListener("click", () => commit((next) => { next.settings.storageNoticeDismissed = true; }));
    document.getElementById("addEntryButton").addEventListener("click", () => openAddForm());
    document.getElementById("settingsButton").addEventListener("click", () => openModal(document.getElementById("settingsDialog"), document.getElementById("settingsTitle")));
    document.getElementById("resetPlannerButton").addEventListener("click", resetPlanner);
    document.getElementById("closeSettingsDialog").addEventListener("click", () => closeModal(document.getElementById("settingsDialog")));
    document.getElementById("settingsDialog").addEventListener("cancel", (event) => { event.preventDefault(); closeModal(document.getElementById("settingsDialog")); });
    document.getElementById("reminderButton").addEventListener("click", () => selectTab("upcoming"));
    document.querySelectorAll(".tab").forEach((tab) => {
      tab.addEventListener("click", () => selectTab(tab.dataset.tab));
      tab.addEventListener("keydown", (event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const tabs = Array.from(document.querySelectorAll(".tab"));
        const currentIndex = tabs.indexOf(tab);
        const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
        selectTab(tabs[nextIndex].dataset.tab);
        tabs[nextIndex].focus();
      });
    });
    document.getElementById("pagePrevious").addEventListener("click", () => { if (currentPage > 1) { currentPage -= 1; renderRecords(new Date()); } });
    document.getElementById("pageNext").addEventListener("click", () => { currentPage += 1; renderRecords(new Date()); });
    document.getElementById("dayPagePrevious").addEventListener("click", () => { if (dayCurrentPage > 1) { dayCurrentPage -= 1; renderSelectedDay(new Date()); } });
    document.getElementById("dayPageNext").addEventListener("click", () => { dayCurrentPage += 1; renderSelectedDay(new Date()); });
    document.getElementById("calendarPrevious").addEventListener("click", () => moveCalendar(-1));
    document.getElementById("calendarNext").addEventListener("click", () => moveCalendar(1));
    document.getElementById("calendarToday").addEventListener("click", () => {
      selectCalendarDate(toDateKey(new Date()), true);
    });
    document.getElementById("calendarGrid").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-date]");
      if (!button) return;
      selectCalendarDate(button.dataset.date, event.detail === 0);
    });
    document.getElementById("calendarGrid").addEventListener("keydown", (event) => {
      const button = event.target.closest("button[data-date]");
      if (!button || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const current = parseDateKey(button.dataset.date);
      const offset = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : event.key === "ArrowUp" ? -7 : event.key === "ArrowDown" ? 7 : event.key === "Home" ? -((current.getDay() + 6) % 7) : 6 - ((current.getDay() + 6) % 7);
      selectCalendarDate(toDateKey(addDays(current, offset)), true);
    });
    document.getElementById("addOnSelectedDate").addEventListener("click", () => openAddForm(selectedDateKey));
    document.getElementById("entryForm").addEventListener("submit", (event) => {
      event.preventDefault(); const data = readAndValidateForm(); if (!data) return;
      const context = { ...formContext };
      if (commit((next) => applyFormMutation(next, context, data, new Date().toISOString()), context.mode === "edit" ? "Изменения сохранены" : "Запись добавлена")) attemptCloseForm(true);
    });
    document.getElementById("closeEntryDialog").addEventListener("click", () => attemptCloseForm());
    document.getElementById("cancelEntryButton").addEventListener("click", () => attemptCloseForm());
    document.getElementById("entryDialog").addEventListener("cancel", (event) => { event.preventDefault(); attemptCloseForm(); });
    document.querySelectorAll('input[name="entryKind"]').forEach((radio) => radio.addEventListener("change", updateFormVisibility));
    document.getElementById("entryFrequency").addEventListener("change", updateFormVisibility);
    for (const id of ["entryTitle", "entryAmount", "entryDate", "entryEndDate", "entryNote"]) {
      document.getElementById(id).addEventListener("blur", (event) => validateFieldOnBlur(event.target));
    }
    document.getElementById("entryNote").addEventListener("input", (event) => { document.getElementById("noteCounter").textContent = String(event.target.value.length); });
    document.getElementById("recordList").addEventListener("click", (event) => { const button = event.target.closest("button[data-action]"); if (button) handleRecordAction(button); });
    document.getElementById("choiceSingle").addEventListener("click", () => finishScope("single"));
    document.getElementById("choiceAll").addEventListener("click", () => finishScope("all"));
    document.getElementById("choiceCancel").addEventListener("click", () => finishScope(null));
    document.getElementById("choiceDialog").addEventListener("cancel", (event) => { event.preventDefault(); finishScope(null); });
    document.getElementById("confirmAccept").addEventListener("click", () => finishConfirm(true));
    document.getElementById("confirmCancel").addEventListener("click", () => finishConfirm(false));
    document.getElementById("confirmDialog").addEventListener("cancel", (event) => { event.preventDefault(); finishConfirm(false); });
    document.getElementById("clearDataButton").addEventListener("click", clearAllData);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) render(new Date()); });
    document.addEventListener("keydown", trapModalFocus);
  }
  function boot() {
    const today = new Date(), loaded = loadState(today);
    state = loaded.value;
    selectedDateKey = toDateKey(today);
    selectedMonthKey = getMonthKey(selectedDateKey);
    bindEvents(); render(today);
    if (loaded.recoveryMessage) showStorageError(loaded.recoveryMessage);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
})();

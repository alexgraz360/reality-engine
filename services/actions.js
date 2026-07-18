// Reality Engine · services/actions — LOCAL notes & reminders (Actions P0).
//
// The first "companion does things" layer, deliberately tiny and safe:
// everything lives in device localStorage (via the storage service), nothing
// ever touches the network, and the SHELL enforces a confirmation gate before
// any create/delete commits. This same confirm-first path is the template for
// future external tools (email/APIs) — those come later, on the bridge.

import storage from "./storage.js";

const MAX_ITEMS = 100;
const MAX_TEXT = 500;

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export const actions = {
  // ---- notes ----
  listNotes() { return storage.get("actions.notes", []); },

  addNote(text) {
    const notes = this.listNotes();
    if (notes.length >= MAX_ITEMS) throw new Error(`Note limit reached (${MAX_ITEMS}) — delete some first.`);
    const rec = { id: makeId(), text: String(text).trim().slice(0, MAX_TEXT), at: Date.now() };
    if (!rec.text) throw new Error("Empty note.");
    notes.push(rec);
    storage.set("actions.notes", notes);
    return rec;
  },

  // Resolve by exact id first, then case-insensitive text match.
  findNote(ref) {
    const notes = this.listNotes();
    const q = String(ref || "").toLowerCase();
    return notes.find((n) => n.id === ref) ||
      (q ? notes.find((n) => n.text.toLowerCase().includes(q)) : null) || null;
  },

  deleteNote(id) {
    const notes = this.listNotes();
    const i = notes.findIndex((n) => n.id === id);
    if (i < 0) return null;
    const [rec] = notes.splice(i, 1);
    storage.set("actions.notes", notes);
    return rec;
  },

  // ---- reminders ----
  listReminders() { return storage.get("actions.reminders", []); },

  addReminder(text, when) {
    // "YYYY-MM-DDTHH:MM" (no zone) parses as LOCAL time — exactly what we want.
    const dueMs = when instanceof Date ? when.getTime() : Date.parse(when);
    if (!isFinite(dueMs)) throw new Error("Couldn't understand that time.");
    const reminders = this.listReminders();
    if (reminders.length >= MAX_ITEMS) throw new Error(`Reminder limit reached (${MAX_ITEMS}) — delete some first.`);
    const rec = { id: makeId(), text: String(text).trim().slice(0, MAX_TEXT), dueMs, fired: false, at: Date.now() };
    if (!rec.text) throw new Error("Empty reminder.");
    reminders.push(rec);
    storage.set("actions.reminders", reminders);
    return rec;
  },

  findReminder(ref) {
    const reminders = this.listReminders();
    const q = String(ref || "").toLowerCase();
    return reminders.find((r) => r.id === ref) ||
      (q ? reminders.find((r) => r.text.toLowerCase().includes(q)) : null) || null;
  },

  deleteReminder(id) {
    const reminders = this.listReminders();
    const i = reminders.findIndex((r) => r.id === id);
    if (i < 0) return null;
    const [rec] = reminders.splice(i, 1);
    storage.set("actions.reminders", reminders);
    return rec;
  },

  // Unfired reminders whose time has come (the shell polls this while open).
  dueReminders(now = Date.now()) {
    return this.listReminders().filter((r) => !r.fired && r.dueMs <= now);
  },

  markFired(id) {
    const reminders = this.listReminders();
    const rec = reminders.find((r) => r.id === id);
    if (rec) { rec.fired = true; storage.set("actions.reminders", reminders); }
  },
};

export default actions;

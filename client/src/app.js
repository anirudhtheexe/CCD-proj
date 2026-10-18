import * as Y from "yjs";
import { MonacoBinding } from "y-monaco";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import {
  createApi,
  getOwnedRooms,
  getRoomPermissions,
  setRoomControl,
} from "./api.js";
import { base64ToBytes, bytesToBase64, UUID_RE, setText } from "./utils.js";
import { createEditor, monaco } from "./monaco-editor.js";
import "./styles.css";

const app = document.querySelector("#app");
const live = document.querySelector("#live-status");
const SERVER_ORIGIN = Symbol("server-update");
const SERVER_AWARENESS_ORIGIN = Symbol("server-awareness-update");
const AWARENESS_COLOURS = new Set(["#58a6ff", "#d2a8ff", "#3fb950", "#f778ba", "#f2cc60", "#79c0ff", "#ff967d", "#56d4dd"]);
const state = { currentUser: null, currentScreen: "loading", currentRoom: null, isOwner: false, canControl: false, locked: false, participantCount: 0, participants: [], permissions: [], drawerOpen: false, ws: null, intentionalSocketClose: false, reconnectAttempt: 0, reconnectTimer: null, joined: false, initialSyncReceived: false, yDoc: null, yText: null, editor: null, model: null, binding: null, yListener: null, awareness: null, awarenessUpdateListener: null, awarenessChangeListener: null, awarenessRegistered: false, awarenessIdentity: null, awarenessStyle: null, remoteCursorWidgets: new Map(), awarenessCollisionRetries: 0, executionJobId: null, executionStatus: "", generation: 0, dashboardGeneration: 0, lockPending: false, runPending: false };
let api;

const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value !== false && value != null) node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return node;
};
const clear = () => app.replaceChildren();
const announce = (message) => { live.textContent = message; };
const feedback = (message, type = "info") => { const node = document.querySelector("[data-feedback]"); if (node) { node.textContent = message; node.dataset.type = type; } announce(message); };
const copyWithFallback = (value) => { const textarea = document.createElement("textarea"); textarea.value = value; textarea.setAttribute("readonly", ""); textarea.setAttribute("aria-hidden", "true"); textarea.style.cssText = "position:fixed;opacity:0;pointer-events:none"; document.body.append(textarea); textarea.select(); const copied = document.execCommand("copy"); textarea.remove(); return copied; };
const copyToClipboard = async (value, label) => { try { if (navigator.clipboard?.writeText && window.isSecureContext) await navigator.clipboard.writeText(value); else if (!copyWithFallback(value)) throw new Error("Copy failed"); feedback(`${label} copied.`); } catch { feedback(`Could not copy ${label.toLowerCase()}.`, "error"); } };
const validCredentials = (username, password) => /^[A-Za-z0-9_]{3,32}$/.test(username) && password.length >= 8 && password.length <= 128;

api = createApi(() => sessionExpired());

function topbar({ room = false } = {}) {
  const bar = el("header", { class: "topbar" }, el("a", { class: "brand", href: "/", onClick: (event) => { event.preventDefault(); goDashboard(); } }, "Code Collaborate"));
  const actions = el("div", { class: "top-actions" });
  if (room) actions.append(el("button", { class: "button ghost", type: "button", onClick: () => goDashboard() }, "Back to dashboard"));
  if (state.currentUser) actions.append(el("span", { class: "username", text: state.currentUser.username }), el("button", { class: "button ghost", type: "button", onClick: logout }, "Log out"));
  bar.append(actions); return bar;
}

function renderAuth(initialMessage = "") {
  cleanupRoom(); state.currentScreen = "auth"; clear();
  let mode = "login";
  const title = el("h1", { text: "Collaborate on code, live." });
  const desc = el("p", { class: "muted", text: "Create a room, share its link, and run locked Python or C code together." });
  const username = el("input", { id: "username", name: "username", autocomplete: "username", required: true, minlength: "3", maxlength: "32" });
  const password = el("input", { id: "password", name: "password", type: "password", autocomplete: "current-password", required: true, minlength: "8", maxlength: "128" });
  const error = el("p", { class: "form-message", "aria-live": "polite" });
  const submit = el("button", { class: "button primary", type: "submit" }, "Log in");
  const loginTab = el("button", { class: "tab active", type: "button", "aria-pressed": "true" }, "Log in");
  const registerTab = el("button", { class: "tab", type: "button", "aria-pressed": "false" }, "Register");
  const setMode = (next) => { mode = next; loginTab.classList.toggle("active", mode === "login"); registerTab.classList.toggle("active", mode === "register"); loginTab.setAttribute("aria-pressed", String(mode === "login")); registerTab.setAttribute("aria-pressed", String(mode === "register")); password.autocomplete = mode === "login" ? "current-password" : "new-password"; submit.textContent = mode === "login" ? "Log in" : "Create account"; error.textContent = ""; };
  loginTab.addEventListener("click", () => setMode("login")); registerTab.addEventListener("click", () => setMode("register"));
  const form = el("form", { class: "auth-form", onSubmit: async (event) => { event.preventDefault(); const u = username.value.trim(), p = password.value; if (!validCredentials(u, p)) { error.textContent = "Username must be 3–32 letters, numbers, or underscores; password must be 8–128 characters."; return; } submit.disabled = true; error.textContent = ""; try { state.currentUser = await api(`/api/auth/${mode === "login" ? "login" : "register"}`, { method: "POST", body: { username: u, password: p } }); const roomId = roomIdFromUrl(); if (roomId) openRoom(roomId, true); else renderDashboard(); } catch (e) { error.textContent = e.message; } finally { submit.disabled = false; } } },
    el("label", { for: "username", text: "Username" }), username, el("label", { for: "password", text: "Password" }), password, error, submit);
  const card = el("main", { class: "auth-shell" }, el("section", { class: "auth-card" }, el("div", { class: "eyebrow", text: "Code Collaborate" }), title, desc, el("div", { class: "tabs", role: "tablist" }, loginTab, registerTab), form, el("p", { class: "form-message", "data-feedback": "", text: initialMessage })));
  app.append(card); username.focus();
}

function renderDashboard(message = "") {
  cleanupRoom(); state.currentScreen = "dashboard"; const dashboardGeneration = ++state.dashboardGeneration; clear();
  const language = el("select", { id: "language", "aria-label": "Room language" }, el("option", { value: "python", text: "Python" }), el("option", { value: "c", text: "C" }));
  const createButton = el("button", { class: "button primary", type: "button", text: "Create room", onClick: async () => { createButton.disabled = true; feedback("Creating room…"); try { const room = await api("/api/rooms", { method: "POST", body: { language: language.value } }); await loadRooms(); openRoom(room.id); } catch (e) { feedback(e.message, "error"); } finally { createButton.disabled = false; } } });
  const roomInput = el("input", { id: "join-room", placeholder: "Room UUID", autocomplete: "off", "aria-label": "Room ID" });
  const joinButton = el("button", { class: "button primary", type: "button", text: "Join room", onClick: () => join() });
  const join = async () => { const id = roomInput.value.trim(); if (!UUID_RE.test(id)) { feedback("Enter a valid room UUID.", "error"); return; } joinButton.disabled = true; try { await api(`/api/rooms/${encodeURIComponent(id)}`); openRoom(id); } catch (e) { feedback(e.message, "error"); } finally { joinButton.disabled = false; } };
  roomInput.addEventListener("keydown", (event) => { if (event.key === "Enter") join(); });
  const roomsStatus = el("p", { class: "rooms-status", text: "Loading your rooms…", "aria-live": "polite" });
  const roomsList = el("div", { class: "rooms-list", "aria-live": "polite" });
  const roomsSection = el("section", { class: "my-rooms", "aria-labelledby": "my-rooms-title" }, el("div", { class: "section-heading" }, el("div", {}, el("h2", { id: "my-rooms-title", text: "My Rooms" }), el("p", { class: "muted", text: "Rooms you created. Opening one does not reload the page." })), el("button", { class: "button ghost", type: "button", text: "Refresh", onClick: () => loadRooms() })), roomsStatus, roomsList);
  const main = el("main", { class: "dashboard" }, el("div", { class: "welcome" }, el("p", { class: "eyebrow", text: "Workspace" }), el("h1", { text: `Welcome, ${state.currentUser.username}` }), el("p", { class: "muted", text: "Start a focused shared coding session or join one with its room ID." })), el("div", { class: "cards" }, el("section", { class: "card" }, el("h2", { text: "Create room" }), el("p", { class: "muted", text: "You will own locking, execution, and deletion." }), language, createButton), el("section", { class: "card" }, el("h2", { text: "Join room" }), el("p", { class: "muted", text: "Paste a room ID from an invite." }), roomInput, joinButton)), roomsSection, el("p", { class: "feedback", "data-feedback": "", text: message, "aria-live": "polite" }));
  app.append(topbar(), main);

  const isActiveDashboard = () => state.currentScreen === "dashboard" && state.dashboardGeneration === dashboardGeneration;
  const copyRoomId = (roomId) => copyToClipboard(roomId, "Room ID");
  const formatDate = (value) => { const date = new Date(value); return Number.isNaN(date.getTime()) ? "Unknown creation date" : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date); };
  const shortRoomId = (roomId) => roomId.length > 13 ? `${roomId.slice(0, 8)}…${roomId.slice(-4)}` : roomId;
  const renderRooms = (rooms) => {
    if (!isActiveDashboard()) return;
    roomsList.replaceChildren();
    if (rooms.length === 0) { roomsList.append(el("p", { class: "rooms-empty", text: "You haven’t created any rooms yet." })); return; }
    for (const room of rooms) {
      const roomId = typeof room.id === "string" ? room.id : "";
      const deleteButton = el("button", { class: "button danger", type: "button", text: "Delete", "aria-label": `Delete room ${roomId}` });
      const deleteOwnedRoom = async () => {
        if (!window.confirm(`Delete room ${roomId}? This cannot be undone.`)) return;
        deleteButton.disabled = true;
        try { await api(`/api/rooms/${encodeURIComponent(roomId)}`, { method: "DELETE" }); feedback(`Room ${shortRoomId(roomId)} deleted.`); await loadRooms(); }
        catch (error) { feedback(error.message, "error"); deleteButton.disabled = false; }
      };
      deleteButton.addEventListener("click", deleteOwnedRoom);
      roomsList.append(el("article", { class: "room-card" }, el("div", { class: "room-card-main" }, el("div", { class: "room-card-title" }, el("span", { class: "badge language", text: room.language === "c" ? "C" : "Python" }), el("code", { class: "room-id", title: roomId, "aria-label": `Full room ID: ${roomId}`, text: shortRoomId(roomId) }), el("span", { class: "badge", "data-locked": String(Boolean(room.locked)), text: room.locked ? "Locked" : "Unlocked" })), el("p", { class: "room-created", text: `Created ${formatDate(room.created_at)}` })), el("div", { class: "room-card-actions" }, el("button", { class: "button primary", type: "button", text: "Open", onClick: () => openRoom(roomId) }), el("button", { class: "button ghost", type: "button", text: "Copy Room ID", onClick: () => copyRoomId(roomId) }), deleteButton)));
    }
  };
  const loadRooms = async () => {
    if (!isActiveDashboard()) return;
    roomsStatus.textContent = "Loading your rooms…";
    roomsList.replaceChildren();
    try { const rooms = await getOwnedRooms(api); if (!isActiveDashboard()) return; roomsStatus.textContent = ""; renderRooms(rooms); }
    catch (error) { if (!isActiveDashboard()) return; roomsStatus.textContent = "Could not load your rooms."; roomsList.replaceChildren(el("button", { class: "button ghost", type: "button", text: "Retry", onClick: () => loadRooms() })); feedback(error.message, "error"); }
  };
  loadRooms();
}

function roomIdFromUrl() { return new URL(location.href).searchParams.get("room"); }
function setRoomUrl(id, replace = false) { const url = new URL(location.href); if (id) url.searchParams.set("room", id); else url.searchParams.delete("room"); history[replace ? "replaceState" : "pushState"]({}, "", url); }
function goDashboard(message = "") { cleanupRoom(); setRoomUrl(null); renderDashboard(message); }

async function openRoom(roomId, replace = false) {
  if (!UUID_RE.test(roomId)) { renderDashboard("The room link is invalid."); return; }
  cleanupRoom(); state.currentScreen = "room"; setRoomUrl(roomId, replace); clear();
  const holder = el("main", { class: "room-loading" }, el("p", { class: "feedback", text: "Opening room…", "aria-live": "polite" })); app.append(topbar({ room: true }), holder);
  try { const room = await api(`/api/rooms/${encodeURIComponent(roomId)}`); if (state.currentScreen !== "room") return; startRoom({ id: room.id, language: room.language, locked: room.locked }); } catch (e) { if (state.currentScreen === "room") goDashboard(e.message); }
}

function startRoom(room) {
  state.currentRoom = room; state.locked = Boolean(room.locked); state.canControl = false; state.participants = []; state.permissions = []; state.drawerOpen = false; state.generation += 1; const generation = state.generation;
  clear();
  const status = el("span", { class: "badge", text: "Connecting" }); const lock = el("span", { class: "badge", text: "Unlocked" }); const participants = el("span", { class: "meta", text: "0 connections" }); const role = el("span", { class: "badge", text: "Participant" });
  const roomIdText = el("code", { class: "room-id", text: room.id });
  const lockButton = el("button", { class: "button", type: "button", hidden: true }); const runButton = el("button", { class: "button primary", type: "button", hidden: true, text: "Run" }); const deleteButton = el("button", { class: "button danger", type: "button", hidden: true, text: "Delete" });
  const outputState = el("p", { class: "output-state", text: "No execution yet." }); const job = el("span", { class: "job", text: "" }); const stdout = el("pre", { class: "output stdout", text: "" }); const stderr = el("pre", { class: "output stderr", text: "" }); const editorHost = el("div", { class: "editor-host" });
  const controlNote = el("p", { class: "control-note", text: "The owner can allow you to control locking and execution." });
  const participantList = el("ul", { class: "participant-list", "aria-live": "polite" });
  const permissionStatus = el("p", { class: "permission-status", "aria-live": "polite", text: "" });
  const offlineGrants = el("ul", { class: "participant-list offline-grants" });
  const offlineSection = el("div", { class: "offline-permissions", hidden: true }, el("h3", { text: "Offline control grants" }), offlineGrants);
  const drawerId = `room-participants-${room.id}`;
  const drawerClose = el("button", { class: "button ghost", type: "button", text: "Close" });
  const drawer = el("aside", { id: drawerId, class: "participants-drawer", hidden: true, "aria-labelledby": "participants-title" }, el("div", { class: "drawer-heading" }, el("div", {}, el("h2", { id: "participants-title", text: "Participants" }), el("p", { class: "muted", text: "Connection count includes browser tabs. People are shown once per account." })), drawerClose), controlNote, participantList, permissionStatus, offlineSection);
  const participantButton = el("button", { class: "button ghost", type: "button", "aria-controls": drawerId, "aria-expanded": "false", text: "Participants" });
  const header = el("section", { class: "room-header" }, el("div", {}, el("div", { class: "room-title" }, el("span", { class: "eyebrow", text: "Room" }), roomIdText), el("div", { class: "room-meta" }, el("span", { class: "badge language", text: room.language === "c" ? "C" : "Python" }), role, participants, status, lock)), el("div", { class: "room-actions" }, participantButton, el("button", { class: "button ghost", type: "button", onClick: () => copyToClipboard(room.id, "Room ID") }, "Copy Room ID"), el("button", { class: "button ghost", type: "button", onClick: () => copyToClipboard(`${location.origin}/?room=${room.id}`, "Invite link") }, "Copy Invite Link"), lockButton, runButton, deleteButton));
  const output = el("section", { class: "output-panel" }, el("div", { class: "output-head" }, el("div", {}, el("h2", { text: "Execution output" }), job), el("button", { class: "button ghost", type: "button", onClick: () => { stdout.textContent = ""; stderr.textContent = ""; outputState.textContent = "Output cleared."; job.textContent = ""; } }, "Clear output")), outputState, el("h3", { text: "Standard output" }), stdout, el("h3", { text: "Standard error" }), stderr);
  const body = el("main", { class: "room" }, header, el("div", { class: "editor-shell" }, editorHost), output, drawer, el("p", { class: "feedback", "data-feedback": "", "aria-live": "polite" })); app.append(topbar({ room: true }), body);
  state.ui = { status, lock, participants, role, participantButton, drawer, drawerClose, lockButton, runButton, deleteButton, controlNote, participantList, permissionStatus, offlineSection, offlineGrants, outputState, job, stdout, stderr };
  const { editor, model } = createEditor(editorHost, room.id, room.language); state.editor = editor; state.model = model; state.yDoc = new Y.Doc(); state.yText = state.yDoc.getText("code"); initializeAwareness();
  state.yListener = (update, origin) => { renderRemoteAwareness(); if (origin === SERVER_ORIGIN || !state.ws || state.ws.readyState !== WebSocket.OPEN || !state.joined || !state.initialSyncReceived || state.locked) return; state.ws.send(JSON.stringify({ type: "yjs_update", update: bytesToBase64(update) })); status.textContent = "Saving"; };
  state.yDoc.on("update", state.yListener); participantButton.addEventListener("click", () => setParticipantsDrawer(!state.drawerOpen)); drawerClose.addEventListener("click", () => setParticipantsDrawer(false)); lockButton.addEventListener("click", () => sendLock(!state.locked)); runButton.addEventListener("click", runCode); deleteButton.addEventListener("click", deleteRoom);
  updateRoomUi(); connectSocket(generation);
}

function setParticipantsDrawer(open) { if (!state.ui) return; state.drawerOpen = Boolean(open); state.ui.drawer.hidden = !state.drawerOpen; state.ui.participantButton.setAttribute("aria-expanded", String(state.drawerOpen)); if (state.drawerOpen) state.ui.drawerClose.focus(); }

function selectionFromEditor() {
  const selection = state.editor?.getSelection();
  if (!selection || !state.model || !state.yText) return null;
  let anchor = state.model.getOffsetAt(selection.getStartPosition());
  let head = state.model.getOffsetAt(selection.getEndPosition());
  if (selection.getDirection() === monaco.SelectionDirection.RTL) [anchor, head] = [head, anchor];
  return {
    anchor: Y.createRelativePositionFromTypeIndex(state.yText, anchor),
    head: Y.createRelativePositionFromTypeIndex(state.yText, head),
  };
}

function validAwarenessIdentity(identity) {
  return identity && typeof identity.id === "string" && typeof identity.name === "string" && identity.name.length <= 32 && AWARENESS_COLOURS.has(identity.color);
}

function awarenessColourAlpha(colour) {
  const value = Number.parseInt(colour.slice(1), 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, 0.26)`;
}

function initializeAwareness() {
  state.awareness = new Awareness(state.yDoc);
  state.awarenessStyle = document.createElement("style");
  state.awarenessStyle.dataset.ccdAwareness = "";
  document.head.append(state.awarenessStyle);
  state.remoteCursorWidgets = new Map();
  state.awarenessUpdateListener = ({ added, updated, removed }, origin) => {
    if (origin !== "local" || !state.awarenessRegistered || !state.ws || state.ws.readyState !== WebSocket.OPEN) return;
    const clientIds = [...added, ...updated, ...removed];
    if (clientIds.length !== 1 || clientIds[0] !== state.yDoc?.clientID) return;
    state.ws.send(JSON.stringify({
      type: "awareness_update",
      update: bytesToBase64(encodeAwarenessUpdate(state.awareness, clientIds)),
    }));
  };
  state.awarenessChangeListener = () => renderRemoteAwareness();
  state.awareness.on("update", state.awarenessUpdateListener);
  state.awareness.on("change", state.awarenessChangeListener);
  state.binding = new MonacoBinding(state.yText, state.model, new Set([state.editor]), state.awareness);
}

function removeRemoteCursorWidgets() {
  for (const widget of state.remoteCursorWidgets?.values() || []) {
    state.editor?.removeContentWidget(widget);
  }
  state.remoteCursorWidgets?.clear();
}

function renderRemoteAwareness() {
  if (!state.awareness || !state.editor || !state.model || !state.yDoc) return;
  const active = new Set();
  const css = [];

  for (const [clientId, remoteState] of state.awareness.getStates()) {
    if (clientId === state.yDoc.clientID || !Number.isSafeInteger(clientId)) continue;
    const user = remoteState?.user;
    const selection = remoteState?.selection;
    if (!validAwarenessIdentity(user) || !selection?.head) continue;

    let absolute;
    try { absolute = Y.createAbsolutePositionFromRelativePosition(selection.head, state.yDoc); } catch { continue; }
    if (!absolute || absolute.type !== state.yText) continue;
    const position = state.model.getPositionAt(absolute.index);
    active.add(clientId);
    css.push(`.yRemoteSelection-${clientId}{background:${awarenessColourAlpha(user.color)}!important}.yRemoteSelectionHead-${clientId}::after,.yRemoteSelectionHead-${clientId}::before{border-color:${user.color}!important}`);

    let widget = state.remoteCursorWidgets.get(clientId);
    if (!widget) {
      const node = document.createElement("div");
      node.className = "remote-cursor-label";
      node.setAttribute("aria-hidden", "true");
      node.style.backgroundColor = user.color;
      node.textContent = user.name;
      widget = {
        getId: () => `ccd-remote-cursor-${clientId}`,
        getDomNode: () => node,
        getPosition: () => ({ position: widget.position, preference: [monaco.editor.ContentWidgetPositionPreference.ABOVE] }),
        position,
      };
      state.remoteCursorWidgets.set(clientId, widget);
      state.editor.addContentWidget(widget);
    } else {
      widget.position = position;
      widget.getDomNode().style.backgroundColor = user.color;
      widget.getDomNode().textContent = user.name;
    }
    state.editor.layoutContentWidget(widget);
  }

  for (const [clientId, widget] of state.remoteCursorWidgets) {
    if (!active.has(clientId)) {
      state.editor.removeContentWidget(widget);
      state.remoteCursorWidgets.delete(clientId);
    }
  }
  if (state.awarenessStyle) state.awarenessStyle.textContent = css.join("\n");
}

function registerAwareness() {
  if (!state.initialSyncReceived || !state.joined || state.awarenessRegistered || !state.yDoc || state.ws?.readyState !== WebSocket.OPEN) return;
  state.ws.send(JSON.stringify({ type: "awareness_register", clientId: state.yDoc.clientID }));
}

function republishAwareness() {
  if (!state.awareness || !validAwarenessIdentity(state.awarenessIdentity)) return;
  state.awareness.setLocalState({
    ...state.awareness.getLocalState(),
    user: state.awarenessIdentity,
    selection: selectionFromEditor(),
  });
}

function updateRoomUi() { if (!state.ui) return; const { status, lock, participants, role, lockButton, runButton, deleteButton, controlNote } = state.ui; status.textContent = state.initialSyncReceived && state.ws?.readyState === WebSocket.OPEN ? "Saved" : state.ws?.readyState === WebSocket.OPEN ? "Syncing" : state.reconnectAttempt ? "Reconnecting" : "Connecting"; lock.textContent = state.locked ? "Locked" : "Unlocked"; lock.dataset.locked = String(state.locked); participants.textContent = `${state.participantCount} connection${state.participantCount === 1 ? "" : "s"}`; role.textContent = state.isOwner ? "Owner" : state.canControl ? "Controller" : "Participant"; controlNote.textContent = state.isOwner ? "You can manage control grants, locking, and execution." : state.canControl ? "The owner has allowed you to lock, unlock, and run the locked code." : "The owner can allow you to control locking and execution."; lockButton.hidden = !state.canControl; runButton.hidden = !state.canControl; deleteButton.hidden = !state.isOwner; lockButton.textContent = state.locked ? "Unlock" : "Lock"; lockButton.disabled = !state.joined || state.lockPending; runButton.disabled = !state.canControl || !state.locked || !state.initialSyncReceived || state.runPending; const editable = Boolean(state.ws?.readyState === WebSocket.OPEN && state.joined && state.initialSyncReceived && !state.locked); state.editor?.updateOptions({ readOnly: !editable, domReadOnly: !editable }); renderParticipants(); }

function renderParticipants() {
  if (!state.ui) return;
  const { participantList, permissionStatus, offlineSection, offlineGrants } = state.ui;
  participantList.replaceChildren();

  if (state.participants.length === 0) {
    participantList.append(el("li", { class: "participant-empty", text: "No active participants yet." }));
  }

  for (const participant of state.participants) {
    const isCurrentUser = participant.id === state.currentUser?.id;
    const tags = el("span", { class: "participant-tags" });
    if (participant.isOwner) tags.append(el("span", { class: "badge", text: "Owner" }));
    if (participant.canControl && !participant.isOwner) tags.append(el("span", { class: "badge permission", text: "Controls allowed" }));
    const identity = el("div", { class: "participant-identity" }, el("span", { class: "participant-name", text: participant.username || "Unknown user" }));
    if (isCurrentUser) identity.append(el("span", { class: "meta", text: "You" }));
    identity.append(tags);
    const row = el("li", { class: "participant-row" }, identity);
    if (state.isOwner && !participant.isOwner) {
      const button = el("button", { class: "button ghost permission-button", type: "button", text: participant.canControl ? "Remove controls" : "Allow controls" });
      button.addEventListener("click", () => changeRoomPermission(participant, !participant.canControl, button));
      row.append(button);
    }
    participantList.append(row);
  }

  offlineGrants.replaceChildren();
  const offline = state.permissions.filter((grant) => !state.participants.some((participant) => participant.id === grant.userId));
  offlineSection.hidden = !state.isOwner || offline.length === 0;
  for (const grant of offline) {
    const revoke = el("button", { class: "button ghost permission-button", type: "button", text: "Remove controls" });
    revoke.addEventListener("click", () => changeRoomPermission({ id: grant.userId, username: grant.username }, false, revoke));
    offlineGrants.append(el("li", { class: "participant-row" }, el("div", { class: "participant-identity" }, el("span", { class: "participant-name", text: grant.username || "Unknown user" }), el("span", { class: "badge permission", text: "Controls allowed" })), revoke));
  }

  if (!state.isOwner) permissionStatus.textContent = "";
}

async function loadRoomPermissions(generation = state.generation) {
  if (!state.isOwner || !state.currentRoom || !state.ui) return;
  state.ui.permissionStatus.textContent = "Loading saved control grants…";
  try {
    const permissions = await getRoomPermissions(api, state.currentRoom.id);
    if (generation !== state.generation || !state.isOwner || !state.ui) return;
    state.permissions = permissions;
    state.ui.permissionStatus.textContent = permissions.length ? "Control grants are saved per room." : "No additional control grants.";
    renderParticipants();
  } catch (error) {
    if (generation !== state.generation || !state.ui) return;
    state.ui.permissionStatus.textContent = `Could not load saved control grants: ${error.message}`;
  }
}

async function changeRoomPermission(participant, canControl, button) {
  if (!state.isOwner || !state.currentRoom || !participant?.id) return;
  const generation = state.generation;
  const roomId = state.currentRoom.id;
  button.disabled = true;
  if (state.ui) state.ui.permissionStatus.textContent = canControl ? `Allowing ${participant.username} to control the room…` : `Removing ${participant.username}'s control permission…`;
  try {
    await setRoomControl(api, roomId, participant.id, canControl);
    if (generation !== state.generation || state.currentRoom?.id !== roomId) return;
    if (state.ui) state.ui.permissionStatus.textContent = canControl ? `${participant.username} can now control locking and execution.` : `Removed ${participant.username}'s control permission.`;
    await loadRoomPermissions(generation);
  } catch (error) {
    if (generation !== state.generation || state.currentRoom?.id !== roomId) return;
    if (state.ui) state.ui.permissionStatus.textContent = error.message;
    feedback(error.message, "error");
  } finally { if (generation === state.generation) button.disabled = false; }
}

function connectSocket(generation) { if (generation !== state.generation || state.ws) return; state.intentionalSocketClose = false; const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:"; const socket = new WebSocket(`${wsProtocol}//${window.location.host}/ws`); state.ws = socket; updateRoomUi(); socket.addEventListener("open", () => { if (generation !== state.generation || socket !== state.ws) return; socket.send(JSON.stringify({ type: "join", roomId: state.currentRoom.id })); }); socket.addEventListener("message", (event) => { if (generation === state.generation && socket === state.ws) handleSocketMessage(event.data); }); socket.addEventListener("close", (event) => { if (generation !== state.generation || socket !== state.ws) return; state.ws = null; state.joined = false; state.initialSyncReceived = false; state.awarenessRegistered = false; updateRoomUi(); if (!state.intentionalSocketClose && event.code === 1008) { sessionExpired(); return; } if (!state.intentionalSocketClose) scheduleReconnect(generation); }); socket.addEventListener("error", () => {}); }

function handleSocketMessage(raw) { let message; try { message = JSON.parse(raw); } catch { feedback("Received an invalid server message.", "error"); return; } switch (message.type) { case "joined": state.currentRoom = message.room; state.isOwner = Boolean(message.isOwner); state.canControl = state.isOwner || Boolean(message.canControl); state.locked = Boolean(message.room.locked); state.participantCount = Number(message.participantCount) || 0; state.participants = Array.isArray(message.participants) ? message.participants : []; state.joined = true; state.lockPending = false; updateRoomUi(); if (state.isOwner) loadRoomPermissions(state.generation); break; case "yjs_sync": try { Y.applyUpdate(state.yDoc, base64ToBytes(message.update), SERVER_ORIGIN); state.initialSyncReceived = true; state.reconnectAttempt = 0; updateRoomUi(); registerAwareness(); } catch { feedback("Could not synchronize room content.", "error"); } break; case "yjs_update": try { Y.applyUpdate(state.yDoc, base64ToBytes(message.update), SERVER_ORIGIN); } catch { feedback("Could not apply a shared edit.", "error"); } break; case "awareness_registered": if (message.clientId !== state.yDoc?.clientID || !validAwarenessIdentity(message.identity)) { feedback("Could not register remote cursor awareness.", "error"); break; } try { const active = new Set((Array.isArray(message.activeClientIds) ? message.activeClientIds : []).filter((clientId) => Number.isSafeInteger(clientId))); const stale = [...state.awareness.getStates().keys()].filter((clientId) => clientId !== state.yDoc.clientID && !active.has(clientId)); removeAwarenessStates(state.awareness, stale, SERVER_AWARENESS_ORIGIN); if (typeof message.update === "string" && message.update.length) applyAwarenessUpdate(state.awareness, base64ToBytes(message.update), SERVER_AWARENESS_ORIGIN); state.awarenessIdentity = message.identity; state.awarenessRegistered = true; state.awarenessCollisionRetries = 0; republishAwareness(); renderRemoteAwareness(); } catch { feedback("Could not synchronize remote cursors.", "error"); } break; case "awareness_update": try { applyAwarenessUpdate(state.awareness, base64ToBytes(message.update), SERVER_AWARENESS_ORIGIN); } catch { feedback("Could not apply remote cursor state.", "error"); } break; case "awareness_rejected": if (message.reason === "client_id_collision" && state.awarenessCollisionRetries < 1 && state.currentRoom) { const roomId = state.currentRoom.id; state.awarenessCollisionRetries += 1; feedback("Refreshing the editor to recover a cursor identity collision.", "error"); setTimeout(() => openRoom(roomId, true), 0); } else { feedback(message.error || "Remote cursor update was rejected.", "error"); } break; case "yjs_saved": if (state.ui) state.ui.status.textContent = "Saved"; break; case "presence": state.participantCount = Number(message.participantCount) || 0; state.participants = Array.isArray(message.participants) ? message.participants : state.participants; updateRoomUi(); break; case "permission_changed": if (message.roomId !== state.currentRoom?.id) break; if (message.userId === state.currentUser?.id) { state.canControl = state.isOwner || Boolean(message.canControl); updateRoomUi(); } if (state.isOwner) loadRoomPermissions(state.generation); break; case "lock_state": state.locked = Boolean(message.locked); state.lockPending = false; updateRoomUi(); break; case "edit_rejected": state.locked = true; updateRoomUi(); feedback(message.error || "Room is locked.", "error"); break; case "execution_running": showExecution("Running", message.jobId); break; case "execution_completed": showResult(message.jobId, message.result); break; case "execution_failed": state.runPending = false; showExecution(`Execution failed: ${message.error || "Unknown worker error"}`, message.jobId, true); updateRoomUi(); break; case "room_deleted": cleanupRoom(); setRoomUrl(null); renderDashboard("This room was deleted."); break; case "error": state.lockPending = false; if (/authorized controller|room owner/i.test(message.error || "")) state.canControl = state.isOwner; updateRoomUi(); feedback(message.error || "Server error", "error"); if (message.error === "Session expired") sessionExpired(); break; default: feedback("Received an unknown server message.", "error"); } }

function scheduleReconnect(generation) { if (state.reconnectAttempt >= 5) { if (state.ui) { state.ui.status.textContent = "Disconnected"; const retry = el("button", { class: "button ghost retry", type: "button", text: "Retry", onClick: () => { retry.remove(); state.reconnectAttempt = 0; connectSocket(generation); } }); state.ui.status.after(retry); } return; } const delays = [500, 1000, 2000, 4000, 8000]; const delay = delays[state.reconnectAttempt++]; updateRoomUi(); state.reconnectTimer = setTimeout(() => { state.reconnectTimer = null; connectSocket(generation); }, delay); }
function sendLock(locked) { if (!state.canControl || !state.joined || state.ws?.readyState !== WebSocket.OPEN) return; state.lockPending = true; updateRoomUi(); state.ws.send(JSON.stringify({ type: "set_lock", locked })); }
async function runCode() { if (!state.canControl || !state.locked || state.runPending || !state.currentRoom) return; state.runPending = true; updateRoomUi(); try { const result = await api(`/api/rooms/${encodeURIComponent(state.currentRoom.id)}/run`, { method: "POST" }); state.executionJobId = String(result.jobId); showExecution("Queued", result.jobId); } catch (e) { state.runPending = false; if (e.status === 403) state.canControl = state.isOwner; feedback(e.message, "error"); updateRoomUi(); } }
function showExecution(status, jobId, failure = false) { const nextJobId = jobId == null ? null : String(jobId); if (status === "Queued" && nextJobId === state.executionJobId && state.executionStatus && state.executionStatus !== "Queued") return; state.executionJobId = nextJobId; state.executionStatus = status; if (!state.ui) return; state.ui.outputState.textContent = status; state.ui.outputState.dataset.type = failure ? "error" : ""; state.ui.job.textContent = nextJobId == null ? "" : `Job ${nextJobId}`; }
function showResult(jobId, result = {}) { if (!state.ui) return; const exitCode = Number(result.exitCode); state.executionJobId = String(jobId); state.executionStatus = exitCode === 0 ? "Completed" : "Failed"; state.ui.stdout.textContent = result.stdout || ""; state.ui.stderr.textContent = result.stderr || ""; state.ui.outputState.textContent = exitCode === 0 ? "Completed successfully." : `Exited with code ${Number.isFinite(exitCode) ? exitCode : "unknown"}`; state.ui.outputState.dataset.type = exitCode === 0 ? "success" : "error"; state.ui.job.textContent = `Job ${jobId}`; state.runPending = false; updateRoomUi(); }
async function deleteRoom() { if (!state.isOwner || !state.currentRoom || !window.confirm("Delete this room permanently? This cannot be undone.")) return; try { await api(`/api/rooms/${encodeURIComponent(state.currentRoom.id)}`, { method: "DELETE" }); cleanupRoom(); setRoomUrl(null); renderDashboard("Room deleted."); } catch (e) { feedback(e.message, "error"); } }
function cleanupRoom() { state.generation += 1; state.intentionalSocketClose = true; state.awarenessRegistered = false; if (state.reconnectTimer) clearTimeout(state.reconnectTimer); state.reconnectTimer = null; if (state.ws) { try { state.ws.close(); } catch {} } state.ws = null; if (state.yDoc && state.yListener) state.yDoc.off("update", state.yListener); if (state.awareness && state.awarenessUpdateListener) state.awareness.off("update", state.awarenessUpdateListener); if (state.awareness && state.awarenessChangeListener) state.awareness.off("change", state.awarenessChangeListener); removeRemoteCursorWidgets(); state.awarenessStyle?.remove(); state.binding?.destroy(); state.awareness?.destroy(); state.editor?.dispose(); state.model?.dispose(); state.yDoc?.destroy(); Object.assign(state, { currentRoom: null, isOwner: false, canControl: false, locked: false, participantCount: 0, participants: [], permissions: [], drawerOpen: false, joined: false, initialSyncReceived: false, yDoc: null, yText: null, editor: null, model: null, binding: null, yListener: null, awareness: null, awarenessUpdateListener: null, awarenessChangeListener: null, awarenessIdentity: null, awarenessStyle: null, remoteCursorWidgets: new Map(), executionJobId: null, executionStatus: "", lockPending: false, runPending: false, ui: null }); }
async function logout() { try { await api("/api/auth/logout", { method: "POST" }); } catch (e) { feedback(e.message, "error"); return; } cleanupRoom(); state.currentUser = null; setRoomUrl(null); renderAuth("You have been logged out."); }
function sessionExpired() { if (!state.currentUser) return; cleanupRoom(); state.currentUser = null; setRoomUrl(null); renderAuth("Your session expired. Please log in again."); }
window.addEventListener("popstate", () => { const room = roomIdFromUrl(); if (state.currentUser && room && room !== state.currentRoom?.id) openRoom(room, true); else if (state.currentUser && !room && state.currentScreen === "room") renderDashboard(); });

async function boot() { try { state.currentUser = await api("/api/auth/me"); const room = roomIdFromUrl(); if (room) await openRoom(room, true); else renderDashboard(); } catch (e) { if (e.status === 401) renderAuth(); else renderAuth(e.message); } }
boot();

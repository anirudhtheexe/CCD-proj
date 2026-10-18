import * as decoding from "lib0/decoding";
import {
  modifyAwarenessUpdate,
} from "y-protocols/awareness";

export const MAX_AWARENESS_UPDATE_BYTES = 64 * 1024;
export const MAX_AWARENESS_ENTRIES = 1;
export const MAX_AWARENESS_CLIENT_ID = 0xffffffff;

const COLOURS = [
  "#58a6ff",
  "#d2a8ff",
  "#3fb950",
  "#f778ba",
  "#f2cc60",
  "#79c0ff",
  "#ff967d",
  "#56d4dd",
];

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isSafeJsonValue(value, depth = 0) {
  if (depth > 8) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "string") return value.length <= 2048;
  if (typeof value === "number") return Number.isFinite(value);

  if (Array.isArray(value)) {
    return value.length <= 16 && value.every((item) => isSafeJsonValue(item, depth + 1));
  }

  if (!isPlainObject(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= 16 && entries.every(([key, item]) =>
    key !== "__proto__" &&
    key !== "constructor" &&
    key !== "prototype" &&
    key.length <= 64 &&
    isSafeJsonValue(item, depth + 1)
  );
}

export function isValidAwarenessClientId(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_AWARENESS_CLIENT_ID;
}

export function colourForUser(userId) {
  let hash = 0;
  for (const character of userId) {
    hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  }
  return COLOURS[Math.abs(hash) % COLOURS.length];
}

export function createAwarenessIdentity(userId, username) {
  return {
    id: userId,
    name: username,
    color: colourForUser(userId),
  };
}

export function decodeAwarenessEntries(update) {
  if (!(update instanceof Uint8Array) || update.byteLength === 0) {
    throw new Error("Awareness update must contain data");
  }
  if (update.byteLength > MAX_AWARENESS_UPDATE_BYTES) {
    throw new Error("Awareness update is too large");
  }

  const decoder = decoding.createDecoder(update);
  const length = decoding.readVarUint(decoder);
  if (length !== MAX_AWARENESS_ENTRIES) {
    throw new Error("Awareness updates must contain exactly one client state");
  }

  const clientId = decoding.readVarUint(decoder);
  const clock = decoding.readVarUint(decoder);
  const rawState = decoding.readVarString(decoder);

  if (!isValidAwarenessClientId(clientId) || !Number.isSafeInteger(clock)) {
    throw new Error("Awareness update has an invalid client ID or clock");
  }
  if (rawState.length > 16 * 1024 || decoding.hasContent(decoder)) {
    throw new Error("Awareness update has an invalid payload");
  }

  let state;
  try {
    state = JSON.parse(rawState);
  } catch {
    throw new Error("Awareness update contains invalid JSON");
  }

  return { clientId, clock, state };
}

export function normalizeAwarenessUpdate(update, identity) {
  const entry = decodeAwarenessEntries(update);
  if (entry.state !== null) {
    if (!isPlainObject(entry.state)) {
      throw new Error("Awareness state must be an object or null");
    }
    if (entry.state.selection !== undefined && entry.state.selection !== null) {
      const selection = entry.state.selection;
      if (
        !isPlainObject(selection) ||
        Object.keys(selection).some((key) => key !== "anchor" && key !== "head") ||
        !Object.hasOwn(selection, "anchor") ||
        !Object.hasOwn(selection, "head") ||
        !isPlainObject(selection.anchor) ||
        !isPlainObject(selection.head) ||
        !isSafeJsonValue(selection.anchor) ||
        !isSafeJsonValue(selection.head)
      ) {
        throw new Error("Awareness selection is invalid");
      }
    }
  }

  const normalized = modifyAwarenessUpdate(update, (rawState) => {
    if (rawState === null) return null;
    return {
      user: identity,
      selection: rawState.selection ?? null,
    };
  });

  return { entry, update: normalized };
}

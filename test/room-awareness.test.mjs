import assert from "node:assert/strict";
import test from "node:test";
import * as Y from "yjs";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import {
  createAwarenessIdentity,
  decodeAwarenessEntries,
  normalizeAwarenessUpdate,
} from "../server/room-awareness.js";

const USER_ID = "44444444-4444-4444-8444-444444444444";
const IDENTITY = createAwarenessIdentity(USER_ID, "guest_b");

test("awareness normalization replaces client-supplied identity and colour", () => {
  const document = new Y.Doc();
  const awareness = new Awareness(document);
  const text = document.getText("code");
  text.insert(0, "hello");
  awareness.setLocalState({
    user: { id: "forged", name: "owner", color: "#ffffff" },
    selection: {
      anchor: Y.createRelativePositionFromTypeIndex(text, 1),
      head: Y.createRelativePositionFromTypeIndex(text, 4),
    },
    canControl: true,
  });

  const update = encodeAwarenessUpdate(awareness, [document.clientID]);
  const normalized = normalizeAwarenessUpdate(update, IDENTITY);
  const decoded = decodeAwarenessEntries(normalized.update);

  assert.equal(decoded.clientId, document.clientID);
  assert.deepEqual(decoded.state.user, IDENTITY);
  assert.equal(decoded.state.canControl, undefined);
  assert.ok(decoded.state.selection.anchor);
  awareness.destroy();
  document.destroy();
});

test("multi-entry and malformed awareness updates are rejected before application", () => {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 2);
  encoding.writeVarUint(encoder, 11);
  encoding.writeVarUint(encoder, 1);
  encoding.writeVarString(encoder, JSON.stringify(null));
  encoding.writeVarUint(encoder, 12);
  encoding.writeVarUint(encoder, 1);
  encoding.writeVarString(encoder, JSON.stringify(null));

  assert.throws(
    () => decodeAwarenessEntries(encoding.toUint8Array(encoder)),
    /exactly one client state/
  );
  assert.throws(() => decodeAwarenessEntries(new Uint8Array([1, 2])), /invalid|Unexpected/);
});

test("invalid selection shapes are rejected instead of reaching Monaco", () => {
  const document = new Y.Doc();
  const awareness = new Awareness(document);
  awareness.setLocalState({ selection: "not a relative selection" });

  assert.throws(
    () => normalizeAwarenessUpdate(
      encodeAwarenessUpdate(awareness, [document.clientID]),
      IDENTITY
    ),
    /selection is invalid/
  );
  awareness.destroy();
  document.destroy();
});

test("a reconnect republish with a newer client clock revives a server tombstone", () => {
  const clientDocument = new Y.Doc();
  const serverDocument = new Y.Doc();
  const client = new Awareness(clientDocument);
  const server = new Awareness(serverDocument);
  server.setLocalState(null);

  client.setLocalState({ user: IDENTITY, selection: null });
  applyAwarenessUpdate(server, encodeAwarenessUpdate(client, [client.clientID]), "client");
  assert.ok(server.getStates().has(client.clientID));

  removeAwarenessStates(server, [client.clientID], "disconnect");
  assert.equal(server.getStates().has(client.clientID), false);

  client.setLocalState(client.getLocalState());
  applyAwarenessUpdate(server, encodeAwarenessUpdate(client, [client.clientID]), "reconnect");
  assert.deepEqual(server.getStates().get(client.clientID)?.user, IDENTITY);

  client.destroy();
  server.destroy();
  clientDocument.destroy();
  serverDocument.destroy();
});

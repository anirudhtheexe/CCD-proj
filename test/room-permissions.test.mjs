import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  isUserConnected,
  isValidUuid,
  userCanControl,
} from "../server/room-permissions.js";

const ROOM_A = "11111111-1111-4111-8111-111111111111";
const ROOM_B = "22222222-2222-4222-8222-222222222222";
const OWNER = "33333333-3333-4333-8333-333333333333";
const GUEST_B = "44444444-4444-4444-8444-444444444444";
const GUEST_C = "55555555-5555-4555-8555-555555555555";

test("validates UUID inputs before permission SQL is reached", () => {
  assert.equal(isValidUuid(ROOM_A), true);
  assert.equal(isValidUuid("not-a-uuid"), false);
  assert.equal(isValidUuid(null), false);
});

test("the owner has implicit control without a grant lookup", async () => {
  let queried = false;
  const allowed = await userCanControl(
    { query: async () => { queried = true; return { rowCount: 0 }; } },
    { id: ROOM_A, owner_id: OWNER },
    OWNER
  );

  assert.equal(allowed, true);
  assert.equal(queried, false);
});

test("a persisted grant is scoped to the requested room and user", async () => {
  const calls = [];
  const client = {
    async query(sql, values) {
      calls.push({ sql, values });
      return { rowCount: values[0] === ROOM_A && values[1] === GUEST_B ? 1 : 0 };
    },
  };

  assert.equal(
    await userCanControl(client, { id: ROOM_A, owner_id: OWNER }, GUEST_B),
    true
  );
  assert.equal(
    await userCanControl(client, { id: ROOM_B, owner_id: OWNER }, GUEST_B),
    false
  );
  assert.equal(
    await userCanControl(client, { id: ROOM_A, owner_id: OWNER }, GUEST_C),
    false
  );
  assert.deepEqual(calls[0].values, [ROOM_A, GUEST_B]);
  assert.match(calls[0].sql, /room_permissions/);
});

test("a user remains connected while another tab for that account closes", () => {
  const firstTab = { userId: GUEST_B };
  const secondTab = { userId: GUEST_B };
  const guestC = { userId: GUEST_C };
  const connections = new Map([[ROOM_A, new Set([firstTab, secondTab, guestC])]]);

  assert.equal(isUserConnected(connections, ROOM_A, GUEST_B), true);
  connections.get(ROOM_A).delete(firstTab);
  assert.equal(isUserConnected(connections, ROOM_A, GUEST_B), true);
  connections.get(ROOM_A).delete(secondTab);
  assert.equal(isUserConnected(connections, ROOM_A, GUEST_B), false);
  assert.equal(isUserConnected(connections, ROOM_B, GUEST_C), false);
});

test("fresh-install schema and additive migration cascade permission rows", async () => {
  const [schema, migration] = await Promise.all([
    readFile(new URL("../db/schema.sql", import.meta.url), "utf8"),
    readFile(
      new URL("../db/migrations/20261018_add_room_permissions.sql", import.meta.url),
      "utf8"
    ),
  ]);

  for (const sql of [schema, migration]) {
    assert.match(sql, /CREATE TABLE IF NOT EXISTS room_permissions/);
    assert.match(sql, /room_id UUID NOT NULL REFERENCES rooms\(id\) ON DELETE CASCADE/);
    assert.match(sql, /user_id UUID NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/);
    assert.match(sql, /PRIMARY KEY \(room_id, user_id\)/);
  }
});

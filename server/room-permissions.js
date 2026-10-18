export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidUuid(value) {
  return typeof value === "string" && UUID_RE.test(value);
}

export async function userCanControl(client, room, userId) {
  if (room.owner_id === userId) {
    return true;
  }

  const result = await client.query(
    `SELECT 1
     FROM room_permissions
     WHERE room_id = $1 AND user_id = $2`,
    [room.id, userId]
  );

  return result.rowCount > 0;
}

export function isUserConnected(roomConnections, roomId, userId) {
  const connections = roomConnections.get(roomId);

  if (!connections) {
    return false;
  }

  for (const connection of connections) {
    if (connection.userId === userId) {
      return true;
    }
  }

  return false;
}

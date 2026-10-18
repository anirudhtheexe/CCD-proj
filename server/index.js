import express from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import argon2 from "argon2";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import pg from "pg";
import { WebSocket, WebSocketServer } from "ws";
import * as Y from "yjs";
import {
  executionQueue,
  executionQueueEvents,
} from "./queue.js";
import {
  isUserConnected,
  isValidUuid,
  userCanControl,
} from "./room-permissions.js";

const PORT = 3000;

const { Pool } = pg;
const PgSession = connectPgSimple(session);

if (!process.env.SESSION_SECRET) {
  throw new Error("SESSION_SECRET is missing");
}

const app = express();

const databaseConfig = {
  host: "/run/postgresql",
  database: "ccd_proj",
  user: process.env.USER,
};

if (process.env.DB_HOST) {
  databaseConfig.host = process.env.DB_HOST;
}
if (process.env.DB_PORT) {
  databaseConfig.port = Number(process.env.DB_PORT);
}
if (process.env.DB_NAME) {
  databaseConfig.database = process.env.DB_NAME;
}
if (process.env.DB_USER) {
  databaseConfig.user = process.env.DB_USER;
}
if (process.env.DB_PASSWORD !== undefined) {
  databaseConfig.password = process.env.DB_PASSWORD;
}
if (process.env.DB_SSL_CA_PATH) {
  databaseConfig.ssl = {
    ca: readFileSync(process.env.DB_SSL_CA_PATH, "utf8"),
    rejectUnauthorized: true,
  };
}

const db = new Pool(databaseConfig);

app.use(express.json());

const sessionMiddleware = session({
  name: "ccd.sid",
  store: new PgSession({ pool: db }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  },
});

app.use(sessionMiddleware);

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({
      error: "Login required",
    });
  }

  next();
}

function establishSession(req, userId) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((error) => {
      if (error) {
        reject(error);
        return;
      }

      req.session.userId = userId;

      req.session.save((saveError) => {
        if (saveError) {
          reject(saveError);
        } else {
          resolve();
        }
      });
    });
  });
}

/*
 * HTTP API
 */

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
  });
});

app.post("/api/auth/register", async (req, res) => {
  const { username, password } = req.body || {};

  if (
    typeof username !== "string" ||
    !/^[a-zA-Z0-9_]{3,32}$/.test(username) ||
    typeof password !== "string" ||
    password.length < 8 ||
    password.length > 128
  ) {
    return res.status(400).json({
      error:
        "Username must be 3–32 letters, numbers, or underscores; password must be 8–128 characters",
    });
  }

  try {
    const userId = randomUUID();

    const passwordHash = await argon2.hash(password, {
      type: argon2.argon2id,
    });

    await db.query(
      `INSERT INTO users (id, username, password_hash)
       VALUES ($1, $2, $3)`,
      [userId, username, passwordHash]
    );

    await establishSession(req, userId);

    res.status(201).json({
      id: userId,
      username,
    });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({
        error: "Username already exists",
      });
    }

    console.error("Registration failed:", error);

    res.status(500).json({
      error: "Registration failed",
    });
  }
});

app.post("/api/auth/login", async (req, res) => {
  const { username, password } = req.body || {};

  if (
    typeof username !== "string" ||
    typeof password !== "string"
  ) {
    return res.status(400).json({
      error: "Username and password required",
    });
  }

  try {
    const result = await db.query(
      `SELECT id, username, password_hash
       FROM users
       WHERE username = $1`,
      [username]
    );

    const user = result.rows[0];

    if (
      !user ||
      !(await argon2.verify(user.password_hash, password))
    ) {
      return res.status(401).json({
        error: "Invalid credentials",
      });
    }

    await establishSession(req, user.id);

    res.json({
      id: user.id,
      username: user.username,
    });
  } catch (error) {
    console.error("Login failed:", error);

    res.status(500).json({
      error: "Login failed",
    });
  }
});

app.get("/api/auth/me", requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, username
       FROM users
       WHERE id = $1`,
      [req.session.userId]
    );

    if (!result.rows[0]) {
      return res.status(401).json({
        error: "User no longer exists",
      });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error("Could not load user:", error);

    res.status(500).json({
      error: "Could not load user",
    });
  }
});

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy((error) => {
    if (error) {
      console.error("Logout failed:", error);

      return res.status(500).json({
        error: "Logout failed",
      });
    }

    res.clearCookie("ccd.sid");
    res.sendStatus(204);
  });
});

app.post("/api/rooms", requireAuth, async (req, res) => {
  const language = req.body?.language;

  if (!["python", "c"].includes(language)) {
    return res.status(400).json({
      error: "language must be 'python' or 'c'",
    });
  }

  try {
    const result = await db.query(
      `INSERT INTO rooms (id, language, owner_id)
       VALUES ($1, $2, $3)
       RETURNING id, language, locked, owner_id, created_at`,
      [
        randomUUID(),
        language,
        req.session.userId,
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("Could not create room:", error);

    res.status(500).json({
      error: "Could not create room",
    });
  }
});

app.get("/api/rooms", requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, language, locked, created_at
       FROM rooms
       WHERE owner_id = $1
       ORDER BY created_at DESC`,
      [req.session.userId]
    );

    res.json({
      rooms: result.rows,
    });
  } catch (error) {
    console.error("Could not list rooms:", error);

    res.status(500).json({
      error: "Could not list rooms",
    });
  }
});

app.get(
  "/api/rooms/:roomId",
  requireAuth,
  async (req, res) => {
    try {
      const result = await db.query(
        `SELECT id, language, locked, owner_id, created_at
         FROM rooms
         WHERE id = $1`,
        [req.params.roomId]
      );

      if (!result.rows[0]) {
        return res.status(404).json({
          error: "Room not found",
        });
      }

      res.json(result.rows[0]);
    } catch (error) {
      console.error("Could not load room:", error);

      res.status(500).json({
        error: "Could not load room",
      });
    }
  }
);

app.post("/api/rooms/:roomId/run", requireAuth, async (req, res) => {
  if (!isValidUuid(req.params.roomId)) {
    return res.status(400).json({ error: "Invalid room ID" });
  }

  try {
    const result = await db.query(
      `SELECT id, language, locked, locked_code, owner_id
       FROM rooms
       WHERE id = $1`,
      [req.params.roomId]
    );

    const room = result.rows[0];

    if (!room) {
      return res.status(404).json({ error: "Room not found" });
    }

    if (!(await userCanControl(db, room, req.session.userId))) {
      return res.status(403).json({
        error: "Only the room owner or an authorized controller can run code",
      });
    }

    if (!room.locked) {
      return res.status(409).json({
        error: "Lock the editor before running code",
      });
    }

    if (room.locked_code === null) {
      return res.status(409).json({
        error: "No locked code available",
      });
    }

    const job = await executionQueue.add("execute", {
      roomId: room.id,
      requestedBy: req.session.userId,
      language: room.language,
      code: room.locked_code,
    });

    res.status(202).json({
      message: "Execution queued",
      jobId: job.id,
    });
  } catch (error) {
    console.error("Could not queue execution:", error);
    res.status(500).json({ error: "Could not queue execution" });
  }
});

app.get(
  "/api/rooms/:roomId/permissions",
  requireAuth,
  async (req, res) => {
    const roomId = req.params.roomId;

    if (!isValidUuid(roomId)) {
      return res.status(400).json({ error: "Invalid room ID" });
    }

    try {
      const roomResult = await db.query(
        `SELECT id, owner_id
         FROM rooms
         WHERE id = $1`,
        [roomId]
      );
      const room = roomResult.rows[0];

      if (!room) {
        return res.status(404).json({ error: "Room not found" });
      }

      if (room.owner_id !== req.session.userId) {
        return res.status(403).json({
          error: "Only the room owner can manage permissions",
        });
      }

      const result = await db.query(
        `SELECT permission.user_id, users.username, permission.created_at
         FROM room_permissions AS permission
         JOIN users ON users.id = permission.user_id
         WHERE permission.room_id = $1
         ORDER BY users.username ASC`,
        [roomId]
      );

      res.json({
        permissions: result.rows.map((permission) => ({
          userId: permission.user_id,
          username: permission.username,
          canControl: true,
          connected: isUserConnected(
            roomConnections,
            roomId,
            permission.user_id
          ),
          createdAt: permission.created_at,
        })),
      });
    } catch (error) {
      console.error("Could not load room permissions:", error);
      res.status(500).json({ error: "Could not load room permissions" });
    }
  }
);

app.put(
  "/api/rooms/:roomId/permissions/:userId",
  requireAuth,
  async (req, res) => {
    const { roomId, userId } = req.params;
    const { canControl } = req.body || {};

    if (!isValidUuid(roomId) || !isValidUuid(userId)) {
      return res.status(400).json({ error: "Invalid room or user ID" });
    }

    if (typeof canControl !== "boolean") {
      return res.status(400).json({
        error: "canControl must be true or false",
      });
    }

    try {
      const roomResult = await db.query(
        `SELECT id, owner_id
         FROM rooms
         WHERE id = $1`,
        [roomId]
      );
      const room = roomResult.rows[0];

      if (!room) {
        return res.status(404).json({ error: "Room not found" });
      }

      if (room.owner_id !== req.session.userId) {
        return res.status(403).json({
          error: "Only the room owner can manage permissions",
        });
      }

      if (room.owner_id === userId) {
        return res.status(400).json({
          error: "The owner always has control permission",
        });
      }

      const userResult = await db.query(
        `SELECT id
         FROM users
         WHERE id = $1`,
        [userId]
      );

      if (!userResult.rows[0]) {
        return res.status(404).json({ error: "User not found" });
      }

      if (canControl && !isUserConnected(roomConnections, roomId, userId)) {
        return res.status(409).json({
          error: "A user must be connected to receive control permission",
        });
      }

      if (canControl) {
        await db.query(
          `INSERT INTO room_permissions (room_id, user_id)
           VALUES ($1, $2)
           ON CONFLICT (room_id, user_id) DO NOTHING`,
          [roomId, userId]
        );
      } else {
        await db.query(
          `DELETE FROM room_permissions
           WHERE room_id = $1 AND user_id = $2`,
          [roomId, userId]
        );
      }

      broadcastToRoom(roomId, {
        type: "permission_changed",
        roomId,
        userId,
        canControl,
      });
      broadcastRoomPresence(roomId, room.owner_id).catch((error) => {
        console.error("Could not broadcast room presence:", error);
      });

      res.json({ roomId, userId, canControl });
    } catch (error) {
      console.error("Could not change room permissions:", error);
      res.status(500).json({ error: "Could not change room permissions" });
    }
  }
);

app.delete("/api/rooms/:roomId", requireAuth, async (req, res) => {
  const roomId = req.params.roomId;

  try {
    const result = await db.query(
      `SELECT owner_id
       FROM rooms
       WHERE id = $1`,
      [roomId]
    );

    const room = result.rows[0];

    if (!room) {
      return res.status(404).json({
        error: "Room not found",
      });
    }

    if (room.owner_id !== req.session.userId) {
      return res.status(403).json({
        error: "Only the room owner can delete this room",
      });
    }

    await db.query(
      `DELETE FROM rooms
       WHERE id = $1`,
      [roomId]
    );

    // Tell connected clients before closing their sockets.
    broadcastToRoom(roomId, {
      type: "room_deleted",
      roomId,
    });

    const connections = roomConnections.get(roomId);

    if (connections) {
      for (const socket of connections) {
        socket.close(1000, "Room deleted");
      }
    }

    roomConnections.delete(roomId);
    roomDocuments.delete(roomId);

    res.json({
      message: "Room deleted",
      roomId,
    });
  } catch (error) {
    console.error("Could not delete room:", error);
    res.status(500).json({
      error: "Could not delete room",
    });
  }
});

/*
 * HTTP and WebSocket server
 */

const httpServer = createServer(app);

const wss = new WebSocketServer({
  noServer: true,
});

/*
 * Live room connections and Yjs documents
 */

const roomConnections = new Map();
const roomDocuments = new Map();

function sendJson(socket, message) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function broadcastToRoom(roomId, message) {
  const connections = roomConnections.get(roomId);

  if (!connections) {
    return;
  }

  for (const connection of connections) {
    sendJson(connection, message);
  }
}

async function getRoomPresence(roomId, ownerId) {
  const connections = roomConnections.get(roomId);
  const participantCount = connections?.size ?? 0;
  const userIds = [
    ...new Set(
      [...(connections || [])]
        .map((connection) => connection.userId)
        .filter(Boolean)
    ),
  ];

  if (userIds.length === 0) {
    return { participantCount, participants: [] };
  }

  const result = await db.query(
    `SELECT users.id,
            users.username,
            (users.id = $2::uuid OR EXISTS (
              SELECT 1
              FROM room_permissions
              WHERE room_id = $3 AND user_id = users.id
            )) AS can_control
     FROM users
     WHERE users.id = ANY($1::uuid[])`,
    [userIds, ownerId, roomId]
  );
  const byId = new Map(result.rows.map((user) => [user.id, user]));

  return {
    participantCount,
    participants: userIds.flatMap((userId) => {
      const user = byId.get(userId);
      if (!user) return [];
      return [{
        id: user.id,
        username: user.username,
        isOwner: user.id === ownerId,
        canControl: Boolean(user.can_control),
      }];
    }),
  };
}

async function broadcastRoomPresence(roomId, ownerId) {
  const presence = await getRoomPresence(roomId, ownerId);
  broadcastToRoom(roomId, {
    type: "presence",
    ...presence,
  });
}

executionQueueEvents.on("active", async ({ jobId }) => {
  try {
    const job = await executionQueue.getJob(jobId);

    if (!job) return;

    broadcastToRoom(job.data.roomId, {
      type: "execution_running",
      jobId,
    });
  } catch (error) {
    console.error("Could not broadcast running status:", error);
  }
});

executionQueueEvents.on("completed", async ({ jobId, returnvalue }) => {
  try {
    const job = await executionQueue.getJob(jobId);

    if (!job) return;

    broadcastToRoom(job.data.roomId, {
      type: "execution_completed",
      jobId,
      result: returnvalue,
    });
  } catch (error) {
    console.error("Could not broadcast execution result:", error);
  }
});

executionQueueEvents.on("failed", async ({ jobId, failedReason }) => {
  try {
    const job = await executionQueue.getJob(jobId);

    if (!job) return;

    broadcastToRoom(job.data.roomId, {
      type: "execution_failed",
      jobId,
      error: failedReason,
    });
  } catch (error) {
    console.error("Could not broadcast execution failure:", error);
  }
});

function leaveRoom(socket) {
  const roomId = socket.roomId;
  const ownerId = socket.roomOwnerId;

  if (!roomId) {
    return;
  }

  const connections = roomConnections.get(roomId);

  socket.roomId = null;
  socket.roomOwnerId = null;

  if (!connections) {
    return;
  }

  connections.delete(socket);

  if (connections.size === 0) {
    roomConnections.delete(roomId);
    return;
  }

  broadcastRoomPresence(roomId, ownerId).catch((error) => {
    console.error("Could not broadcast room presence:", error);
  });
}

function addToRoom(socket, roomId, ownerId) {
  if (
    socket.roomId &&
    socket.roomId !== roomId
  ) {
    leaveRoom(socket);
  }

  let connections = roomConnections.get(roomId);

  if (!connections) {
    connections = new Set();
    roomConnections.set(roomId, connections);
  }

  connections.add(socket);
  socket.roomId = roomId;
  socket.roomOwnerId = ownerId;

  return connections;
}

/*
 * Yjs document loading
 */

function getStarterCode(language) {
  if (language === "c") {
    return `#include <stdio.h>

int main(void) {
    printf("Hello, world!\\n");
    return 0;
}
`;
  }

  return `print("Hello, world!")
`;
}

async function createRoomDocument(room) {
  const document = new Y.Doc();

  const result = await db.query(
    `SELECT update_bytes
     FROM room_updates
     WHERE room_id = $1
     ORDER BY id`,
    [room.id]
  );

  for (const row of result.rows) {
    Y.applyUpdate(
      document,
      new Uint8Array(row.update_bytes),
      "database"
    );
  }

  if (result.rows.length === 0) {
    const code = document.getText("code");

    document.transact(() => {
      code.insert(
        0,
        getStarterCode(room.language)
      );
    }, "server-initialization");

    const initialUpdate =
      Y.encodeStateAsUpdate(document);

    await db.query(
      `INSERT INTO room_updates (
         room_id,
         update_bytes
       )
       VALUES ($1, $2)`,
      [
        room.id,
        Buffer.from(initialUpdate),
      ]
    );
  }

  return document;
}

async function getRoomDocument(room) {
  let documentPromise =
    roomDocuments.get(room.id);

  if (!documentPromise) {
    documentPromise =
      createRoomDocument(room).catch((error) => {
        roomDocuments.delete(room.id);
        throw error;
      });

    roomDocuments.set(
      room.id,
      documentPromise
    );
  }

  return documentPromise;
}

/*
 * WebSocket authentication
 */

httpServer.on(
  "upgrade",
  (request, socket, head) => {
    const path = new URL(
      request.url,
      "http://localhost"
    ).pathname;

    if (path !== "/ws") {
      socket.end(
        "HTTP/1.1 404 Not Found\r\n\r\n"
      );
      return;
    }

    sessionMiddleware(
      request,
      {},
      (error) => {
        if (error) {
          console.error(
            "WebSocket session error:",
            error
          );

          socket.end(
            "HTTP/1.1 500 Internal Server Error\r\n\r\n"
          );
          return;
        }

        if (!request.session?.userId) {
          socket.end(
            "HTTP/1.1 401 Unauthorized\r\n\r\n"
          );
          return;
        }

        wss.handleUpgrade(
          request,
          socket,
          head,
          (webSocket) => {
            wss.emit(
              "connection",
              webSocket,
              request
            );
          }
        );
      }
    );
  }
);

/*
 * WebSocket messages
 */

wss.on("connection", (socket, request) => {
  console.log("WebSocket connected:", request.session.userId);

  socket.roomId = null;
  socket.roomOwnerId = null;
  socket.userId = request.session.userId;

  socket.on("message", (data, isBinary) => {
    request.session.reload(async (sessionError) => {
      if (sessionError || !request.session?.userId) {
        sendJson(socket, {
          type: "error",
          error: "Session expired",
        });

        socket.close(1008, "Authentication required");
        return;
      }

      if (isBinary) {
        sendJson(socket, {
          type: "error",
          error: "Expected a JSON message",
        });
        return;
      }

      let message;

      try {
        message = JSON.parse(data.toString());
      } catch {
        sendJson(socket, {
          type: "error",
          error: "Invalid JSON",
        });
        return;
      }

      /*
       * Join room
       */

      if (message.type === "join") {
        if (!isValidUuid(message.roomId)) {
          sendJson(socket, {
            type: "error",
            error: "Invalid room ID",
          });
          return;
        }

        try {
          const result = await db.query(
            `SELECT id, language, locked, owner_id, created_at
             FROM rooms
             WHERE id = $1`,
            [message.roomId]
          );

          const room = result.rows[0];

          if (!room) {
            sendJson(socket, {
              type: "error",
              error: "Room not found",
            });
            return;
          }

          const document = await getRoomDocument(room);
          socket.userId = request.session.userId;
          addToRoom(socket, room.id, room.owner_id);
          const [presence, canControl] = await Promise.all([
            getRoomPresence(room.id, room.owner_id),
            userCanControl(db, room, request.session.userId),
          ]);

          sendJson(socket, {
            type: "joined",
            room: {
              id: room.id,
              language: room.language,
              locked: room.locked,
              ownerId: room.owner_id,
              createdAt: room.created_at,
            },
            isOwner: room.owner_id === request.session.userId,
            canControl,
            ...presence,
          });

          sendJson(socket, {
            type: "yjs_sync",
            update: Buffer.from(
              Y.encodeStateAsUpdate(document)
            ).toString("base64"),
          });

          broadcastToRoom(room.id, {
            type: "presence",
            ...presence,
          });

          console.log(
            `User ${request.session.userId} joined room ${room.id}`
          );
        } catch (error) {
          console.error("Could not join room:", error);

          sendJson(socket, {
            type: "error",
            error: "Could not join room",
          });
        }

        return;
      }

      /*
       * Lock or unlock room
       */

      if (message.type === "set_lock") {
        if (!socket.roomId) {
          sendJson(socket, {
            type: "error",
            error: "Join a room first",
          });
          return;
        }

        if (typeof message.locked !== "boolean") {
          sendJson(socket, {
            type: "error",
            error: "locked must be true or false",
          });
          return;
        }

        let client;
        let transactionStarted = false;

        try {
          client = await db.connect();

          await client.query("BEGIN");
          transactionStarted = true;

          const roomResult = await client.query(
            `SELECT owner_id
             FROM rooms
             WHERE id = $1
             FOR UPDATE`,
            [socket.roomId]
          );

          const room = roomResult.rows[0];

          if (!room) {
            await client.query("ROLLBACK");
            transactionStarted = false;

            sendJson(socket, {
              type: "error",
              error: "Room no longer exists",
            });
            return;
          }

          if (!(await userCanControl(client, {
            id: socket.roomId,
            owner_id: room.owner_id,
          }, request.session.userId))) {
            await client.query("ROLLBACK");
            transactionStarted = false;

            sendJson(socket, {
              type: "error",
              error: "Only the room owner or an authorized controller can change the lock",
            });
            return;
          }

          let lockedCode = null;

          if (message.locked) {
            const updatesResult = await client.query(
              `SELECT update_bytes
               FROM room_updates
               WHERE room_id = $1
               ORDER BY id`,
              [socket.roomId]
            );

            const snapshotDocument = new Y.Doc();

            try {
              for (const row of updatesResult.rows) {
                Y.applyUpdate(
                  snapshotDocument,
                  new Uint8Array(row.update_bytes)
                );
              }

              lockedCode = snapshotDocument
                .getText("code")
                .toString();
            } finally {
              snapshotDocument.destroy();
            }
          }

          const updateResult = await client.query(
            `UPDATE rooms
             SET locked = $1,
                 locked_code = CASE
                   WHEN $1 = true THEN $2
                   ELSE locked_code
                 END,
                 locked_at = CASE
                   WHEN $1 = true THEN NOW()
                   ELSE NULL
                 END
             WHERE id = $3
             RETURNING id, locked, locked_at`,
            [
              message.locked,
              lockedCode,
              socket.roomId,
            ]
          );

          await client.query("COMMIT");
          transactionStarted = false;

          const updatedRoom = updateResult.rows[0];

          broadcastToRoom(socket.roomId, {
            type: "lock_state",
            roomId: updatedRoom.id,
            locked: updatedRoom.locked,
            lockedAt: updatedRoom.locked_at,
          });

          console.log(
            `Room ${updatedRoom.id} lock changed to ${updatedRoom.locked}`
          );
        } catch (error) {
          if (client && transactionStarted) {
            await client.query("ROLLBACK").catch(() => {});
          }

          console.error("Could not change room lock:", error);

          sendJson(socket, {
            type: "error",
            error: "Could not change room lock",
          });
        } finally {
          client?.release();
        }

        return;
      }

      /*
       * Receive Yjs update
       */

      if (message.type === "yjs_update") {
        if (!socket.roomId) {
          sendJson(socket, {
            type: "error",
            error: "Join a room first",
          });
          return;
        }

        if (
          typeof message.update !== "string" ||
          message.update.length === 0 ||
          message.update.length > 2_000_000
        ) {
          sendJson(socket, {
            type: "error",
            error: "Invalid Yjs update",
          });
          return;
        }

        const documentPromise = roomDocuments.get(socket.roomId);

        if (!documentPromise) {
          sendJson(socket, {
            type: "error",
            error: "Room document is not loaded",
          });
          return;
        }

        let document;
        let update;

        try {
          document = await documentPromise;

          const updateBuffer = Buffer.from(
            message.update,
            "base64"
          );

          if (
            updateBuffer.length === 0 ||
            updateBuffer.toString("base64") !== message.update
          ) {
            throw new Error("Invalid base64");
          }

          update = new Uint8Array(updateBuffer);

          const validationDocument = new Y.Doc();

          try {
            Y.applyUpdate(
              validationDocument,
              Y.encodeStateAsUpdate(document)
            );

            Y.applyUpdate(validationDocument, update);
          } finally {
            validationDocument.destroy();
          }
        } catch {
          sendJson(socket, {
            type: "error",
            error: "Invalid Yjs update",
          });
          return;
        }

        let client;
        let transactionStarted = false;

        try {
          client = await db.connect();

          await client.query("BEGIN");
          transactionStarted = true;

          const roomResult = await client.query(
            `SELECT locked
             FROM rooms
             WHERE id = $1
             FOR UPDATE`,
            [socket.roomId]
          );

          const room = roomResult.rows[0];

          if (!room) {
            await client.query("ROLLBACK");
            transactionStarted = false;

            sendJson(socket, {
              type: "error",
              error: "Room no longer exists",
            });
            return;
          }

          if (room.locked) {
            await client.query("ROLLBACK");
            transactionStarted = false;

            sendJson(socket, {
              type: "edit_rejected",
              error: "Room is locked",
            });
            return;
          }

          await client.query(
            `INSERT INTO room_updates (room_id, update_bytes)
             VALUES ($1, $2)`,
            [
              socket.roomId,
              Buffer.from(update),
            ]
          );

          await client.query("COMMIT");
          transactionStarted = false;

          Y.applyUpdate(document, update, "remote-client");

          const connections = roomConnections.get(socket.roomId);

          if (connections) {
            for (const connection of connections) {
              if (connection !== socket) {
                sendJson(connection, {
                  type: "yjs_update",
                  update: message.update,
                });
              }
            }
          }

          sendJson(socket, {
            type: "yjs_saved",
          });
        } catch (error) {
          if (client && transactionStarted) {
            await client.query("ROLLBACK").catch(() => {});
          }

          console.error("Could not save Yjs update:", error);

          sendJson(socket, {
            type: "error",
            error: "Could not save edit",
          });
        } finally {
          client?.release();
        }

        return;
      }

      sendJson(socket, {
        type: "error",
        error: "Unknown message type",
      });
    });
  });

  socket.on("close", () => {
    leaveRoom(socket);
    console.log("WebSocket disconnected");
  });

  socket.on("error", (error) => {
    console.error("WebSocket error:", error);
  });
});

httpServer.listen(PORT, () => {
  console.log(
    `Server running at http://localhost:${PORT}`
  );
});

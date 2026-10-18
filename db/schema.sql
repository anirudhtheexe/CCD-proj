CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS rooms (
    id UUID PRIMARY KEY,
    language TEXT NOT NULL CHECK (language IN ('python', 'c')),
    locked BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Add these to the rooms table you already created.
ALTER TABLE rooms
    ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES users(id);

ALTER TABLE rooms
    ADD COLUMN IF NOT EXISTS locked_code TEXT;

ALTER TABLE rooms
    ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS rooms_owner_id_idx
    ON rooms(owner_id);

CREATE TABLE IF NOT EXISTS room_updates (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    update_bytes BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS room_updates_room_id_id_idx
    ON room_updates(room_id, id);

-- A row grants a non-owner permission to lock, unlock, and run one room.
-- The room owner always has this authority implicitly and has no row here.
CREATE TABLE IF NOT EXISTS room_permissions (
    room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (room_id, user_id)
);

CREATE INDEX IF NOT EXISTS room_permissions_user_id_idx
    ON room_permissions(user_id);

-- For express-session with connect-pg-simple later
CREATE TABLE IF NOT EXISTS "session" (
    "sid" VARCHAR PRIMARY KEY,
    "sess" JSON NOT NULL,
    "expire" TIMESTAMP(6) NOT NULL
);

CREATE INDEX IF NOT EXISTS "IDX_session_expire"
    ON "session"("expire");

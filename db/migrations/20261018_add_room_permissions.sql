-- Additive migration for persistent room control grants.
-- Run once against an existing database before deploying the permission feature.

CREATE TABLE IF NOT EXISTS room_permissions (
    room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (room_id, user_id)
);

CREATE INDEX IF NOT EXISTS room_permissions_user_id_idx
    ON room_permissions(user_id);

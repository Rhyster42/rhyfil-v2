-- People and devices (docs/decisions/0010).
CREATE TABLE staff (
    id           uuid PRIMARY KEY,
    name         text        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 40),
    role         text        NOT NULL CHECK (role IN ('barista', 'manager')),
    pin_verifier text        NOT NULL,
    active       boolean     NOT NULL DEFAULT true,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE devices (
    id               uuid PRIMARY KEY,
    name             text        NOT NULL,
    -- Letter used in order numbers (A-042): docs/decisions/0011.
    code             text        NOT NULL UNIQUE,
    token_hash       bytea       NOT NULL UNIQUE,
    enrolled_by      uuid REFERENCES staff (id),
    created_at       timestamptz NOT NULL DEFAULT now(),
    last_seen_at     timestamptz,
    -- What the tablet last reported: unsynced documents and open orders.
    reported_pending integer     NOT NULL DEFAULT 0,
    reported_open    integer     NOT NULL DEFAULT 0,
    revoked_at       timestamptz
);

CREATE TABLE enrollment_codes (
    code_hash  bytea PRIMARY KEY,
    kind       text        NOT NULL CHECK (kind IN ('setup', 'device')),
    created_by uuid REFERENCES staff (id),
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz,
    used_at    timestamptz,
    used_by    uuid REFERENCES devices (id)
);

-- Back-office sessions, bound to the device the manager signed in on.
CREATE TABLE sessions (
    token_hash bytea PRIMARY KEY,
    staff_id   uuid        NOT NULL REFERENCES staff (id),
    device_id  uuid        NOT NULL REFERENCES devices (id),
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL
);

-- Every saved menu, forever (docs/decisions/0004). The highest version is live.
CREATE TABLE menu_versions (
    version    bigint PRIMARY KEY CHECK (version > 0),
    doc        jsonb       NOT NULL,
    created_by uuid REFERENCES staff (id),
    created_at timestamptz NOT NULL DEFAULT now()
);

-- Change counters tablets compare so they only download what moved.
CREATE TABLE counters (
    name  text PRIMARY KEY,
    value bigint NOT NULL
);

INSERT INTO counters (name, value) VALUES ('staff', 1);

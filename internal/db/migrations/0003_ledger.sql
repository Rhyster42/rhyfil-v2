-- Every synced document, exactly as stored after validation
-- (docs/decisions/0002). It's the canonical record and what tablets pull.
-- seq is the pull cursor; it's drawn under an advisory lock so it follows
-- commit order (docs/decisions/0012).
CREATE SEQUENCE ledger_seq;

CREATE TABLE ledger (
    seq           bigint PRIMARY KEY,
    id            uuid        NOT NULL UNIQUE,
    kind          text        NOT NULL CHECK (kind IN ('order', 'refund')),
    device_id     uuid        NOT NULL REFERENCES devices (id),
    business_date date        NOT NULL,
    doc           jsonb       NOT NULL,
    received_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ledger_business_date ON ledger (business_date, seq);

-- Projections for reporting, written in the same transaction as the ledger
-- row. Staff columns aren't foreign keys: an unknown person is flagged, not
-- rejected (docs/decisions/0003).
CREATE TABLE orders (
    id            uuid PRIMARY KEY REFERENCES ledger (id),
    device_id     uuid        NOT NULL REFERENCES devices (id),
    staff_id      uuid        NOT NULL,
    number        text        NOT NULL,
    business_date date        NOT NULL,
    status        text        NOT NULL CHECK (status IN ('paid', 'voided')),
    menu_version  bigint      NOT NULL,
    subtotal      bigint      NOT NULL,
    tax           bigint      NOT NULL,
    total         bigint      NOT NULL,
    voided_at     timestamptz,
    voided_by     uuid,
    void_reason   text,
    created_at    timestamptz NOT NULL,
    closed_at     timestamptz NOT NULL,
    received_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX orders_business_date ON orders (business_date);

CREATE TABLE order_lines (
    id          uuid PRIMARY KEY,
    order_id    uuid        NOT NULL REFERENCES orders (id),
    position    integer     NOT NULL,
    item_id     text        NOT NULL,
    item_name   text        NOT NULL,
    category    text        NOT NULL,
    qty         integer     NOT NULL CHECK (qty > 0),
    unit_price  bigint      NOT NULL,
    line_total  bigint      NOT NULL,
    taxable     boolean     NOT NULL,
    added_at    timestamptz NOT NULL,
    voided_at   timestamptz,
    voided_by   uuid,
    void_reason text
);

CREATE INDEX order_lines_order ON order_lines (order_id);

CREATE TABLE order_line_mods (
    line_id     uuid    NOT NULL REFERENCES order_lines (id),
    position    integer NOT NULL,
    option_id   text    NOT NULL,
    group_id    text    NOT NULL,
    group_name  text    NOT NULL,
    option_name text    NOT NULL,
    qty         integer NOT NULL,
    delta       bigint  NOT NULL,
    PRIMARY KEY (line_id, position)
);

CREATE TABLE payments (
    id              uuid PRIMARY KEY,
    order_id        uuid        NOT NULL REFERENCES orders (id),
    position        integer     NOT NULL,
    tender          text        NOT NULL CHECK (tender IN ('cash', 'card')),
    amount          bigint      NOT NULL,
    tendered        bigint      NOT NULL,
    change          bigint      NOT NULL,
    covers_line_ids uuid[]      NOT NULL DEFAULT '{}',
    staff_id        uuid        NOT NULL,
    created_at      timestamptz NOT NULL,
    reversed_at     timestamptz,
    reversed_by     uuid,
    reversal_reason text
);

CREATE INDEX payments_order ON payments (order_id);

-- Stored documents that broke a business rule, for a manager to review
-- (docs/decisions/0003).
CREATE TABLE flags (
    id            bigserial PRIMARY KEY,
    kind          text        NOT NULL,
    subject_kind  text        NOT NULL CHECK (subject_kind IN ('order', 'refund')),
    subject_id    uuid        NOT NULL,
    device_id     uuid REFERENCES devices (id),
    business_date date,
    message       text        NOT NULL,
    detail        jsonb       NOT NULL DEFAULT '{}',
    created_at    timestamptz NOT NULL DEFAULT now(),
    resolved_at   timestamptz,
    resolved_by   uuid REFERENCES staff (id),
    resolution    text
);

CREATE INDEX flags_unresolved ON flags (created_at) WHERE resolved_at IS NULL;

-- Documents the server couldn't store, kept for diagnosis.
CREATE TABLE sync_rejections (
    id          bigserial PRIMARY KEY,
    device_id   uuid        NOT NULL REFERENCES devices (id),
    doc_id      text        NOT NULL,
    kind        text        NOT NULL,
    payload     text        NOT NULL,
    error       text        NOT NULL,
    received_at timestamptz NOT NULL DEFAULT now()
);

-- A business day's close-out (docs/decisions/0017). Created here because
-- ingest flags documents that arrive for a day already closed out.
CREATE TABLE closeouts (
    business_date date PRIMARY KEY,
    closed_by     uuid        NOT NULL REFERENCES staff (id),
    closed_at     timestamptz NOT NULL DEFAULT now(),
    note          text        NOT NULL DEFAULT '',
    snapshot      jsonb       NOT NULL
);

-- One drawer per tablet. expected = opening float + cash taken − cash refunded.
CREATE TABLE closeout_drawers (
    business_date date   NOT NULL REFERENCES closeouts (business_date),
    device_id     uuid   NOT NULL REFERENCES devices (id),
    opening_float bigint NOT NULL,
    expected      bigint NOT NULL,
    counted       bigint NOT NULL,
    over_short    bigint GENERATED ALWAYS AS (counted - expected) STORED,
    PRIMARY KEY (business_date, device_id)
);

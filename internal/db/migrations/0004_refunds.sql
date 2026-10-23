-- Money returned after an order closed (docs/decisions/0009). A refund counts
-- on the business date it happened, not the date of the sale.
CREATE TABLE refunds (
    id            uuid PRIMARY KEY REFERENCES ledger (id),
    order_id      uuid        NOT NULL REFERENCES orders (id),
    payment_id    uuid        NOT NULL REFERENCES payments (id),
    device_id     uuid        NOT NULL REFERENCES devices (id),
    staff_id      uuid        NOT NULL,
    approved_by   uuid        NOT NULL,
    business_date date        NOT NULL,
    tender        text        NOT NULL CHECK (tender IN ('cash', 'card')),
    -- Total returned, tax included; tax is the part of amount that was tax.
    amount        bigint      NOT NULL CHECK (amount > 0),
    tax           bigint      NOT NULL CHECK (tax >= 0 AND tax <= amount),
    reason        text        NOT NULL,
    created_at    timestamptz NOT NULL,
    received_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX refunds_business_date ON refunds (business_date);
CREATE INDEX refunds_order ON refunds (order_id);
CREATE INDEX refunds_payment ON refunds (payment_id);

-- Which lines a refund covered, for item reports. Empty for custom amounts.
CREATE TABLE refund_lines (
    refund_id uuid    NOT NULL REFERENCES refunds (id),
    line_id   uuid    NOT NULL REFERENCES order_lines (id),
    qty       integer NOT NULL CHECK (qty > 0),
    amount    bigint  NOT NULL CHECK (amount >= 0),
    tax       bigint  NOT NULL CHECK (tax >= 0),
    PRIMARY KEY (refund_id, line_id)
);

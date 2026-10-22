-- Store-wide settings: a single row. Pricing settings (the tax rate) live in
-- the menu document instead, so an order's menu version pins its tax rate.
CREATE TABLE settings (
    id                 boolean PRIMARY KEY DEFAULT true CHECK (id),
    store_name         text    NOT NULL DEFAULT 'Coffee Shop',
    timezone           text    NOT NULL DEFAULT 'America/New_York',
    currency           text    NOT NULL DEFAULT 'USD',
    -- Minutes after local midnight when the business day rolls over.
    day_cutoff_minutes integer NOT NULL DEFAULT 240 CHECK (day_cutoff_minutes BETWEEN 0 AND 720),
    default_float      bigint  NOT NULL DEFAULT 15000 CHECK (default_float >= 0),
    -- Bumped on every change so tablets can pull only when it moved.
    version            bigint  NOT NULL DEFAULT 1
);

INSERT INTO settings DEFAULT VALUES;

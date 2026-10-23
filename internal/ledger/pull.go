package ledger

import (
	"context"
	"encoding/json"

	"github.com/jackc/pgx/v5"
)

// Entry is a stored document as tablets pull it.
type Entry struct {
	Seq  int64           `json:"seq"`
	Kind string          `json:"kind"`
	Doc  json.RawMessage `json:"doc"`
}

// Page is a run of ledger entries and the cursor to continue from.
type Page struct {
	Entries []Entry `json:"entries"`
	Cursor  int64   `json:"cursor"`
	HasMore bool    `json:"hasMore"`
}

// After returns up to limit documents after cursor whose business date is
// on or after since, in seq order.
func (s *Service) After(ctx context.Context, cursor int64, since string, limit int) (Page, error) {
	page := Page{Entries: []Entry{}, Cursor: cursor}
	// One snapshot for both queries, so moving the cursor to the newest row
	// can't skip one that committed in between.
	err := pgx.BeginTxFunc(ctx, s.Pool, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly}, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			SELECT seq, kind, doc FROM ledger
			WHERE seq > $1 AND business_date >= $2
			ORDER BY seq LIMIT $3`, cursor, since, limit+1)
		if err != nil {
			return err
		}
		entries, err := pgx.CollectRows(rows, pgx.RowToStructByPos[Entry])
		if err != nil {
			return err
		}
		if len(entries) > limit {
			page.HasMore = true
			entries = entries[:limit]
		}
		page.Entries = entries
		if len(entries) > 0 {
			page.Cursor = entries[len(entries)-1].Seq
		}
		if !page.HasMore {
			// Everything visible was returned or is too old to send, so the
			// cursor can jump to the newest row.
			var newest int64
			if err := tx.QueryRow(ctx, "SELECT coalesce(max(seq), 0) FROM ledger").Scan(&newest); err != nil {
				return err
			}
			page.Cursor = max(page.Cursor, newest)
		}
		return nil
	})
	return page, err
}

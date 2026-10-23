package reports

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"

	"coffeepos/internal/httpx"
)

// FlagView is a flag with enough context to act on it (docs/decisions/0003).
type FlagView struct {
	ID           int64           `json:"id"`
	Kind         string          `json:"kind"`
	SubjectKind  string          `json:"subjectKind"`
	SubjectID    string          `json:"subjectId"`
	OrderID      string          `json:"orderId"`
	Number       string          `json:"number"`
	DeviceCode   string          `json:"deviceCode"`
	BusinessDate string          `json:"businessDate"`
	Message      string          `json:"message"`
	Detail       json.RawMessage `json:"detail"`
	CreatedAt    time.Time       `json:"createdAt"`
	ResolvedAt   *time.Time      `json:"resolvedAt"`
	ResolvedBy   *string         `json:"resolvedBy"`
	Resolution   *string         `json:"resolution"`
}

// Flags lists flags: "open", "resolved" or "all", newest first.
func (s *Service) Flags(ctx context.Context, status string) ([]FlagView, error) {
	return rows(ctx, s.Pool, `
		SELECT f.id, f.kind, f.subject_kind, f.subject_id::text,
		       coalesce(o.id, r.order_id)::text, coalesce(o.number, ro.number, ''), coalesce(d.code, ''),
		       coalesce(f.business_date::text, ''), f.message, f.detail, f.created_at,
		       f.resolved_at, st.name, f.resolution
		FROM flags f
		LEFT JOIN orders o ON f.subject_kind = 'order' AND o.id = f.subject_id
		LEFT JOIN refunds r ON f.subject_kind = 'refund' AND r.id = f.subject_id
		LEFT JOIN orders ro ON ro.id = r.order_id
		LEFT JOIN devices d ON d.id = f.device_id
		LEFT JOIN staff st ON st.id = f.resolved_by
		WHERE $1 = 'all' OR ($1 = 'open') = (f.resolved_at IS NULL)
		ORDER BY f.created_at DESC, f.id DESC LIMIT 500`, []any{status}, func(r pgx.Row, v *FlagView) error {
		return r.Scan(&v.ID, &v.Kind, &v.SubjectKind, &v.SubjectID, &v.OrderID, &v.Number, &v.DeviceCode,
			&v.BusinessDate, &v.Message, &v.Detail, &v.CreatedAt, &v.ResolvedAt, &v.ResolvedBy, &v.Resolution)
	})
}

// ResolveFlag records that a manager looked into a flag.
func (s *Service) ResolveFlag(ctx context.Context, id int64, managerID, note string) error {
	tag, err := s.Pool.Exec(ctx, `
		UPDATE flags SET resolved_at = $2, resolved_by = $3, resolution = $4
		WHERE id = $1 AND resolved_at IS NULL`, id, s.Now(), managerID, note)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return httpx.Errorf(http.StatusConflict, "not_open", "that flag doesn't exist or was already resolved")
	}
	return nil
}

// Rejection is a document the server refused, kept for diagnosis.
type Rejection struct {
	ID         int64     `json:"id"`
	DeviceName string    `json:"deviceName"`
	DeviceCode string    `json:"deviceCode"`
	DocID      string    `json:"docId"`
	Kind       string    `json:"kind"`
	Error      string    `json:"error"`
	ReceivedAt time.Time `json:"receivedAt"`
}

// Rejections lists the most recent refused documents.
func (s *Service) Rejections(ctx context.Context) ([]Rejection, error) {
	return rows(ctx, s.Pool, `
		SELECT r.id, d.name, d.code, r.doc_id, r.kind, r.error, r.received_at
		FROM sync_rejections r JOIN devices d ON d.id = r.device_id
		ORDER BY r.received_at DESC, r.id DESC LIMIT 100`, nil, func(r pgx.Row, v *Rejection) error {
		return r.Scan(&v.ID, &v.DeviceName, &v.DeviceCode, &v.DocID, &v.Kind, &v.Error, &v.ReceivedAt)
	})
}

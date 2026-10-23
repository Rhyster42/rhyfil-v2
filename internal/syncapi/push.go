package syncapi

import (
	"encoding/json"
	"net/http"

	"coffeepos/internal/auth"
	"coffeepos/internal/httpx"
	"coffeepos/internal/ledger"
)

// maxPush is the most documents one push may carry.
const maxPush = 100

type pushRequest struct {
	Mutations []struct {
		ID   string          `json:"id"`
		Kind string          `json:"kind"`
		Doc  json.RawMessage `json:"doc"`
	} `json:"mutations"`
}

// HandlePush: POST /api/sync/push {mutations: [{id, kind, doc}]}. Documents
// are stored in the order sent. If one can't be stored right now, it and
// everything after it come back as "retry" so the outbox stays in order (a
// refund never arrives before its order).
func (s *Service) HandlePush(w http.ResponseWriter, r *http.Request) error {
	var req pushRequest
	if err := httpx.DecodeJSON(w, r, &req); err != nil {
		return err
	}
	if len(req.Mutations) > maxPush {
		return httpx.BadRequest("push at most %d documents at a time", maxPush)
	}
	ctx := r.Context()
	device := auth.DeviceFrom(ctx)
	results := make([]ledger.Result, 0, len(req.Mutations))
	retrying := false
	for _, m := range req.Mutations {
		if retrying {
			results = append(results, ledger.Result{ID: m.ID, Status: ledger.Retry, Error: "waiting for an earlier document"})
			continue
		}
		res := s.Ledger.Ingest(ctx, device.ID, m.ID, m.Kind, m.Doc)
		retrying = res.Status == ledger.Retry
		results = append(results, res)
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"results": results, "serverTime": s.Now()})
	return nil
}

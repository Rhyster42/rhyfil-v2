package reports

import (
	"net/http"
	"strconv"
	"strings"

	"coffeepos/internal/auth"
	"coffeepos/internal/httpx"
)

// HandleSales: GET /api/reports/sales?from=YYYY-MM-DD&to=YYYY-MM-DD
func (s *Service) HandleSales(w http.ResponseWriter, r *http.Request) error {
	from, to := r.URL.Query().Get("from"), r.URL.Query().Get("to")
	if err := checkRange(from, to); err != nil {
		return httpx.BadRequest("%v", err)
	}
	rep, err := s.Sales(r.Context(), from, to)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, rep)
	return nil
}

// HandleCloseout: GET /api/closeouts/{date}
func (s *Service) HandleCloseout(w http.ResponseWriter, r *http.Request) error {
	st, err := s.Status(r.Context(), r.PathValue("date"))
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, st)
	return nil
}

// HandleClose: POST /api/closeouts/{date} {drawers: [{deviceId, openingFloat, counted}], note}
func (s *Service) HandleClose(w http.ResponseWriter, r *http.Request) error {
	var req CloseRequest
	if err := httpx.DecodeJSON(w, r, &req); err != nil {
		return err
	}
	c, err := s.Close(r.Context(), r.PathValue("date"), auth.ManagerFrom(r.Context()).ID, req)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusCreated, c)
	return nil
}

// HandleFlags: GET /api/flags?status=open|resolved|all
func (s *Service) HandleFlags(w http.ResponseWriter, r *http.Request) error {
	status := r.URL.Query().Get("status")
	if status == "" {
		status = "open"
	}
	if status != "open" && status != "resolved" && status != "all" {
		return httpx.BadRequest("status must be open, resolved or all")
	}
	flags, err := s.Flags(r.Context(), status)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, flags)
	return nil
}

// HandleResolveFlag: POST /api/flags/{id}/resolve {note}
func (s *Service) HandleResolveFlag(w http.ResponseWriter, r *http.Request) error {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		return httpx.ErrNotFound
	}
	var req struct {
		Note string `json:"note"`
	}
	if err := httpx.DecodeJSON(w, r, &req); err != nil {
		return err
	}
	note := strings.TrimSpace(req.Note)
	if note == "" || len(note) > 500 {
		return httpx.BadRequest("say what you found (up to 500 characters)")
	}
	if err := s.ResolveFlag(r.Context(), id, auth.ManagerFrom(r.Context()).ID, note); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

// HandleRejections: GET /api/sync/rejections
func (s *Service) HandleRejections(w http.ResponseWriter, r *http.Request) error {
	list, err := s.Rejections(r.Context())
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, list)
	return nil
}

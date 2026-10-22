package auth

import (
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5"

	"coffeepos/internal/httpx"
)

var errWrongPIN = &httpx.Error{Status: http.StatusUnauthorized, Code: "wrong_pin", Message: "wrong PIN"}

// HandleCreateSession: POST /api/sessions {staffId, pin}. Signs a manager in
// to the back office on this device. Wrong PINs are rate-limited per device
// and person.
func (s *Service) HandleCreateSession(w http.ResponseWriter, r *http.Request) error {
	var req struct {
		StaffID string `json:"staffId"`
		PIN     string `json:"pin"`
	}
	if err := httpx.DecodeJSON(w, r, &req); err != nil {
		return err
	}
	ctx := r.Context()
	device := DeviceFrom(ctx)
	key := device.ID + "/" + req.StaffID
	if wait := s.pinLimiter.wait(key); wait > 0 {
		return tooManyAttempts(wait)
	}

	var st Staff
	var verifier string
	err := s.pool.QueryRow(ctx, `
		SELECT id, name, role, active, pin_verifier FROM staff WHERE id::text = $1 AND active`,
		req.StaffID).Scan(&st.ID, &st.Name, &st.Role, &st.Active, &verifier)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	if err != nil || !VerifyPIN(verifier, req.PIN) {
		s.pinLimiter.fail(key)
		return errWrongPIN
	}
	s.pinLimiter.reset(key)
	if st.Role != RoleManager {
		return httpx.Errorf(http.StatusForbidden, "not_manager", "only managers can open the back office")
	}

	token, hash := NewToken()
	expires := s.opts.Now().Add(s.opts.SessionTTL)
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO sessions (token_hash, staff_id, device_id, expires_at) VALUES ($1, $2, $3, $4)`,
		hash, st.ID, device.ID, expires); err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusCreated, map[string]any{"token": token, "expiresAt": expires, "staff": st})
	return nil
}

// HandleDeleteSession: DELETE /api/sessions (with X-Session) signs out.
func (s *Service) HandleDeleteSession(w http.ResponseWriter, r *http.Request) error {
	_, err := s.pool.Exec(r.Context(), "DELETE FROM sessions WHERE token_hash = $1 AND device_id = $2",
		HashToken(r.Header.Get("X-Session")), DeviceFrom(r.Context()).ID)
	if err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

package auth

import (
	"context"
	"crypto/subtle"
	"errors"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"

	"coffeepos/internal/httpx"
)

var errBadCode = &httpx.Error{Status: http.StatusUnauthorized, Code: "bad_code", Message: "that code isn't valid (it may have expired or been used)"}

// EnsureSetupCode returns a new one-time setup code while nobody has been set
// up yet, replacing any earlier unused one. It returns "" once staff exist.
func (s *Service) EnsureSetupCode(ctx context.Context) (string, error) {
	var code string
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", enrollLock); err != nil {
			return err
		}
		var staff int
		if err := tx.QueryRow(ctx, "SELECT count(*) FROM staff").Scan(&staff); err != nil || staff > 0 {
			return err
		}
		if _, err := tx.Exec(ctx, "DELETE FROM enrollment_codes WHERE kind = 'setup' AND used_at IS NULL"); err != nil {
			return err
		}
		code = NewCode()
		_, err := tx.Exec(ctx, "INSERT INTO enrollment_codes (code_hash, kind) VALUES ($1, 'setup')", HashToken(code))
		return err
	})
	return code, err
}

// HandleSetupStatus: GET /api/setup → {needsSetup}
func (s *Service) HandleSetupStatus(w http.ResponseWriter, r *http.Request) error {
	var staff int
	if err := s.pool.QueryRow(r.Context(), "SELECT count(*) FROM staff").Scan(&staff); err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]bool{"needsSetup": staff == 0})
	return nil
}

type enrolled struct {
	Device Device `json:"device"`
	Token  string `json:"token"`
	Staff  *Staff `json:"staff,omitempty"`
}

// HandleSetup: POST /api/setup {code, managerName, pin, deviceName}. Creates
// the first manager and enrolls the device they're using. Only works while
// there are no staff.
func (s *Service) HandleSetup(w http.ResponseWriter, r *http.Request) error {
	var req struct {
		Code        string `json:"code"`
		ManagerName string `json:"managerName"`
		PIN         string `json:"pin"`
		DeviceName  string `json:"deviceName"`
	}
	if err := httpx.DecodeJSON(w, r, &req); err != nil {
		return err
	}
	name, err := cleanName("your name", req.ManagerName)
	if err != nil {
		return err
	}
	deviceName, err := cleanName("device name", req.DeviceName)
	if err != nil {
		return err
	}
	if !ValidPIN(req.PIN) {
		return httpx.BadRequest("PIN must be 4-8 digits")
	}
	if wait := s.enrollLimiter.wait("setup"); wait > 0 {
		return tooManyAttempts(wait)
	}
	verifier, err := HashPIN(req.PIN, s.opts.PINIterations)
	if err != nil {
		return err
	}

	var out enrolled
	ctx := r.Context()
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", enrollLock); err != nil {
			return err
		}
		var staff int
		if err := tx.QueryRow(ctx, "SELECT count(*) FROM staff").Scan(&staff); err != nil {
			return err
		}
		if staff > 0 {
			return httpx.Errorf(http.StatusConflict, "already_set_up", "this POS is already set up; enroll the device with a code from a manager")
		}
		tag, err := tx.Exec(ctx, `
			UPDATE enrollment_codes SET used_at = now()
			WHERE code_hash = $1 AND kind = 'setup' AND used_at IS NULL`, HashToken(normalizeCode(req.Code)))
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			s.enrollLimiter.fail("setup")
			return errBadCode
		}
		manager := Staff{ID: newID(), Name: name, Role: RoleManager, Active: true}
		if _, err := tx.Exec(ctx, `
			INSERT INTO staff (id, name, role, pin_verifier) VALUES ($1, $2, $3, $4)`,
			manager.ID, manager.Name, manager.Role, verifier); err != nil {
			return err
		}
		if err := bumpStaffVersion(ctx, tx); err != nil {
			return err
		}
		device, token, err := createDevice(ctx, tx, deviceName, &manager.ID)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE enrollment_codes SET used_by = $1 WHERE code_hash = $2`,
			device.ID, HashToken(normalizeCode(req.Code))); err != nil {
			return err
		}
		out = enrolled{Device: device, Token: token, Staff: &manager}
		return nil
	})
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusCreated, out)
	return nil
}

// HandleEnroll: POST /api/devices/enroll {code, name} → device and token.
func (s *Service) HandleEnroll(w http.ResponseWriter, r *http.Request) error {
	var req struct {
		Code string `json:"code"`
		Name string `json:"name"`
	}
	if err := httpx.DecodeJSON(w, r, &req); err != nil {
		return err
	}
	name, err := cleanName("device name", req.Name)
	if err != nil {
		return err
	}
	if wait := s.enrollLimiter.wait("enroll"); wait > 0 {
		return tooManyAttempts(wait)
	}
	code := normalizeCode(req.Code)
	demo := s.opts.DemoEnrollCode != "" &&
		subtle.ConstantTimeCompare([]byte(code), []byte(normalizeCode(s.opts.DemoEnrollCode))) == 1

	var out enrolled
	ctx := r.Context()
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", enrollLock); err != nil {
			return err
		}
		var createdBy *string
		if !demo {
			err := tx.QueryRow(ctx, `
				UPDATE enrollment_codes SET used_at = now()
				WHERE code_hash = $1 AND kind = 'device' AND used_at IS NULL AND expires_at > $2
				RETURNING created_by`, HashToken(code), s.opts.Now()).Scan(&createdBy)
			if errors.Is(err, pgx.ErrNoRows) {
				s.enrollLimiter.fail("enroll")
				return errBadCode
			} else if err != nil {
				return err
			}
		}
		device, token, err := createDevice(ctx, tx, name, createdBy)
		if err != nil {
			return err
		}
		if !demo {
			if _, err := tx.Exec(ctx, `UPDATE enrollment_codes SET used_by = $1 WHERE code_hash = $2`,
				device.ID, HashToken(code)); err != nil {
				return err
			}
		}
		out = enrolled{Device: device, Token: token}
		return nil
	})
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusCreated, out)
	return nil
}

// HandleCreateCode: POST /api/devices/codes → {code, expiresAt}. A manager
// reads the code to whoever is setting up the new tablet.
func (s *Service) HandleCreateCode(w http.ResponseWriter, r *http.Request) error {
	code := NewCode()
	expires := s.opts.Now().Add(15 * time.Minute)
	_, err := s.pool.Exec(r.Context(), `
		INSERT INTO enrollment_codes (code_hash, kind, created_by, expires_at) VALUES ($1, 'device', $2, $3)`,
		HashToken(code), ManagerFrom(r.Context()).ID, expires)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusCreated, map[string]any{"code": FormatCode(code), "expiresAt": expires})
	return nil
}

// DeviceStatus is a device as the back office sees it.
type DeviceStatus struct {
	Device
	CreatedAt       time.Time  `json:"createdAt"`
	LastSeenAt      *time.Time `json:"lastSeenAt"`
	ReportedPending int        `json:"reportedPending"`
	ReportedOpen    int        `json:"reportedOpen"`
	RevokedAt       *time.Time `json:"revokedAt"`
}

// Devices lists every device, enrolled order.
func (s *Service) Devices(ctx context.Context) ([]DeviceStatus, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, name, code, created_at, last_seen_at, reported_pending, reported_open, revoked_at
		FROM devices ORDER BY created_at, code`)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (DeviceStatus, error) {
		var d DeviceStatus
		err := row.Scan(&d.ID, &d.Name, &d.Code, &d.CreatedAt, &d.LastSeenAt, &d.ReportedPending, &d.ReportedOpen, &d.RevokedAt)
		return d, err
	})
}

// HandleListDevices: GET /api/devices
func (s *Service) HandleListDevices(w http.ResponseWriter, r *http.Request) error {
	devices, err := s.Devices(r.Context())
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, devices)
	return nil
}

// HandleRevokeDevice: POST /api/devices/{id}/revoke. A manager can't revoke
// the device they're using, so they can't lock themselves out.
func (s *Service) HandleRevokeDevice(w http.ResponseWriter, r *http.Request) error {
	id := r.PathValue("id")
	if id == DeviceFrom(r.Context()).ID {
		return httpx.Errorf(http.StatusConflict, "own_device", "you can't remove the device you're using")
	}
	tag, err := s.pool.Exec(r.Context(), `
		UPDATE devices SET revoked_at = $2 WHERE id::text = $1 AND revoked_at IS NULL`, id, s.opts.Now())
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return httpx.ErrNotFound
	}
	if _, err := s.pool.Exec(r.Context(), "DELETE FROM sessions WHERE device_id::text = $1", id); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

package auth

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"

	"coffeepos/internal/db"
	"coffeepos/internal/httpx"
)

func bumpStaffVersion(ctx context.Context, q db.Querier) error {
	_, err := q.Exec(ctx, "UPDATE counters SET value = value + 1 WHERE name = 'staff'")
	return err
}

// StaffMember is what tablets receive: everyone (so old orders can show
// names), with PIN verifiers for active staff only.
type StaffMember struct {
	Staff
	PINVerifier *string `json:"pinVerifier"`
}

// StaffVersion changes whenever anyone is added or edited.
func (s *Service) StaffVersion(ctx context.Context) (int64, error) {
	var v int64
	err := s.pool.QueryRow(ctx, "SELECT value FROM counters WHERE name = 'staff'").Scan(&v)
	return v, err
}

// StaffSnapshot returns the staff list for tablets and its version, read
// consistently.
func (s *Service) StaffSnapshot(ctx context.Context) (int64, []StaffMember, error) {
	var version int64
	var members []StaffMember
	err := pgx.BeginTxFunc(ctx, s.pool, pgx.TxOptions{AccessMode: pgx.ReadOnly, IsoLevel: pgx.RepeatableRead}, func(tx pgx.Tx) error {
		if err := tx.QueryRow(ctx, "SELECT value FROM counters WHERE name = 'staff'").Scan(&version); err != nil {
			return err
		}
		rows, err := tx.Query(ctx, `
			SELECT id, name, role, active, CASE WHEN active THEN pin_verifier END
			FROM staff ORDER BY name, id`)
		if err != nil {
			return err
		}
		members, err = pgx.CollectRows(rows, func(row pgx.CollectableRow) (StaffMember, error) {
			var m StaffMember
			err := row.Scan(&m.ID, &m.Name, &m.Role, &m.Active, &m.PINVerifier)
			return m, err
		})
		return err
	})
	return version, members, err
}

// StaffExists reports whether id names a staff member, active or not.
func (s *Service) StaffExists(ctx context.Context, q db.Querier, id string) (bool, error) {
	var ok bool
	err := q.QueryRow(ctx, "SELECT EXISTS (SELECT 1 FROM staff WHERE id::text = $1)", id).Scan(&ok)
	return ok, err
}

// IsActiveManager reports whether id is an active manager.
func (s *Service) IsActiveManager(ctx context.Context, q db.Querier, id string) (bool, error) {
	var ok bool
	err := q.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM staff WHERE id::text = $1 AND active AND role = 'manager')`, id).Scan(&ok)
	return ok, err
}

type staffRow struct {
	Staff
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

const staffColumns = "id, name, role, active, created_at, updated_at"

func scanStaff(row pgx.Row) (staffRow, error) {
	var s staffRow
	err := row.Scan(&s.ID, &s.Name, &s.Role, &s.Active, &s.CreatedAt, &s.UpdatedAt)
	return s, err
}

// HandleListStaff: GET /api/staff
func (s *Service) HandleListStaff(w http.ResponseWriter, r *http.Request) error {
	rows, err := s.pool.Query(r.Context(), "SELECT "+staffColumns+" FROM staff ORDER BY active DESC, name")
	if err != nil {
		return err
	}
	list, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (staffRow, error) { return scanStaff(row) })
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, list)
	return nil
}

func validRole(role string) bool { return role == RoleBarista || role == RoleManager }

// HandleCreateStaff: POST /api/staff {name, role, pin}
func (s *Service) HandleCreateStaff(w http.ResponseWriter, r *http.Request) error {
	var req struct {
		Name string `json:"name"`
		Role string `json:"role"`
		PIN  string `json:"pin"`
	}
	if err := httpx.DecodeJSON(w, r, &req); err != nil {
		return err
	}
	name, err := cleanName("name", req.Name)
	if err != nil {
		return err
	}
	if !validRole(req.Role) {
		return httpx.BadRequest("role must be barista or manager")
	}
	if !ValidPIN(req.PIN) {
		return httpx.BadRequest("PIN must be 4-8 digits")
	}
	verifier, err := HashPIN(req.PIN, s.opts.PINIterations)
	if err != nil {
		return err
	}
	ctx := r.Context()
	var created staffRow
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		var err error
		created, err = scanStaff(tx.QueryRow(ctx, `
			INSERT INTO staff (id, name, role, pin_verifier) VALUES ($1, $2, $3, $4)
			RETURNING `+staffColumns, newID(), name, req.Role, verifier))
		if err != nil {
			return err
		}
		return bumpStaffVersion(ctx, tx)
	})
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusCreated, created)
	return nil
}

// HandleUpdateStaff: PATCH /api/staff/{id} {name?, role?, active?, pin?}.
// There must always be at least one active manager left.
func (s *Service) HandleUpdateStaff(w http.ResponseWriter, r *http.Request) error {
	var req struct {
		Name   *string `json:"name"`
		Role   *string `json:"role"`
		Active *bool   `json:"active"`
		PIN    *string `json:"pin"`
	}
	if err := httpx.DecodeJSON(w, r, &req); err != nil {
		return err
	}
	var name, verifier *string
	if req.Name != nil {
		n, err := cleanName("name", *req.Name)
		if err != nil {
			return err
		}
		name = &n
	}
	if req.Role != nil && !validRole(*req.Role) {
		return httpx.BadRequest("role must be barista or manager")
	}
	if req.PIN != nil {
		if !ValidPIN(*req.PIN) {
			return httpx.BadRequest("PIN must be 4-8 digits")
		}
		v, err := HashPIN(*req.PIN, s.opts.PINIterations)
		if err != nil {
			return err
		}
		verifier = &v
	}

	ctx := r.Context()
	var updated staffRow
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		var err error
		updated, err = scanStaff(tx.QueryRow(ctx, `
			UPDATE staff SET
				name = coalesce($2, name),
				role = coalesce($3, role),
				active = coalesce($4, active),
				pin_verifier = coalesce($5, pin_verifier),
				updated_at = now()
			WHERE id::text = $1
			RETURNING `+staffColumns, r.PathValue("id"), name, req.Role, req.Active, verifier))
		if errors.Is(err, pgx.ErrNoRows) {
			return httpx.ErrNotFound
		} else if err != nil {
			return err
		}
		var managers int
		if err := tx.QueryRow(ctx, "SELECT count(*) FROM staff WHERE active AND role = 'manager'").Scan(&managers); err != nil {
			return err
		}
		if managers == 0 {
			return httpx.Errorf(http.StatusConflict, "last_manager", "there must be at least one active manager")
		}
		if req.Active != nil && !*req.Active || req.Role != nil && *req.Role != RoleManager || verifier != nil {
			// Sessions end when someone is deactivated, demoted or re-PINned.
			if _, err := tx.Exec(ctx, "DELETE FROM sessions WHERE staff_id = $1", updated.ID); err != nil {
				return err
			}
		}
		return bumpStaffVersion(ctx, tx)
	})
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, updated)
	return nil
}

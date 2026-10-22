package auth

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"coffeepos/internal/db"
	"coffeepos/internal/httpx"
)

// Options configures the service.
type Options struct {
	// PINIterations for new verifiers; 0 means DefaultPINIterations.
	PINIterations int
	// DemoEnrollCode, if set, enrolls any number of devices. Demos only.
	DemoEnrollCode string
	// SessionTTL for back-office sessions; 0 means 12 hours.
	SessionTTL time.Duration
	Now        func() time.Time
}

// Service owns devices, staff and sessions.
type Service struct {
	pool          *pgxpool.Pool
	opts          Options
	pinLimiter    *limiter
	enrollLimiter *limiter
}

// New returns a Service with defaults filled in.
func New(pool *pgxpool.Pool, opts Options) *Service {
	if opts.PINIterations == 0 {
		opts.PINIterations = DefaultPINIterations
	}
	if opts.SessionTTL == 0 {
		opts.SessionTTL = 12 * time.Hour
	}
	if opts.Now == nil {
		opts.Now = func() time.Time { return time.Now().UTC() }
	}
	return &Service{
		pool:          pool,
		opts:          opts,
		pinLimiter:    newLimiter(5, time.Minute, opts.Now),
		enrollLimiter: newLimiter(10, time.Minute, opts.Now),
	}
}

// Device is an enrolled tablet (or a manager's laptop).
type Device struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Code string `json:"code"`
}

// Staff is a person who signs in on a device.
type Staff struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Role   string `json:"role"`
	Active bool   `json:"active"`
}

// Roles.
const (
	RoleBarista = "barista"
	RoleManager = "manager"
)

type ctxKey int

const (
	deviceKey ctxKey = iota
	managerKey
)

// DeviceFrom returns the authenticated device. Only valid behind
// RequireDevice.
func DeviceFrom(ctx context.Context) Device {
	d, _ := ctx.Value(deviceKey).(Device)
	return d
}

// ManagerFrom returns the manager whose session authorized the request. Only
// valid behind RequireManager.
func ManagerFrom(ctx context.Context) Staff {
	s, _ := ctx.Value(managerKey).(Staff)
	return s
}

var (
	errDeviceUnknown  = &httpx.Error{Status: http.StatusUnauthorized, Code: "device_unknown", Message: "this device isn't enrolled (or was removed)"}
	errSessionInvalid = &httpx.Error{Status: http.StatusUnauthorized, Code: "session_invalid", Message: "manager sign-in required"}
)

// RequireDevice authenticates the device token in the Authorization header.
func (s *Service) RequireDevice(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		if !ok || token == "" {
			httpx.WriteError(w, r, errDeviceUnknown)
			return
		}
		var d Device
		err := s.pool.QueryRow(r.Context(),
			`SELECT id, name, code FROM devices WHERE token_hash = $1 AND revoked_at IS NULL`,
			HashToken(token)).Scan(&d.ID, &d.Name, &d.Code)
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.WriteError(w, r, errDeviceUnknown)
			return
		} else if err != nil {
			httpx.WriteError(w, r, err)
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), deviceKey, d)))
	})
}

// RequireManager authenticates the device and then the manager session in
// the X-Session header, which must belong to that device.
func (s *Service) RequireManager(next http.Handler) http.Handler {
	return s.RequireDevice(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token := r.Header.Get("X-Session")
		if token == "" {
			httpx.WriteError(w, r, errSessionInvalid)
			return
		}
		var st Staff
		err := s.pool.QueryRow(r.Context(), `
			SELECT st.id, st.name, st.role, st.active
			FROM sessions se JOIN staff st ON st.id = se.staff_id
			WHERE se.token_hash = $1 AND se.device_id = $2 AND se.expires_at > $3`,
			HashToken(token), DeviceFrom(r.Context()).ID, s.opts.Now()).Scan(&st.ID, &st.Name, &st.Role, &st.Active)
		if errors.Is(err, pgx.ErrNoRows) || (err == nil && (!st.Active || st.Role != RoleManager)) {
			httpx.WriteError(w, r, errSessionInvalid)
			return
		} else if err != nil {
			httpx.WriteError(w, r, err)
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), managerKey, st)))
	}))
}

// Heartbeat records that a device checked in, with what it reported.
func (s *Service) Heartbeat(ctx context.Context, deviceID string, pending, open int) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE devices SET last_seen_at = $2, reported_pending = $3, reported_open = $4 WHERE id = $1`,
		deviceID, s.opts.Now(), pending, open)
	return err
}

func cleanName(kind, name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" || utf8.RuneCountInString(name) > 40 {
		return "", httpx.BadRequest("%s must be 1-40 characters", kind)
	}
	return name, nil
}

func newID() string { return uuid.Must(uuid.NewV7()).String() }

// enrollLock serializes enrollments so device letters are handed out once.
const enrollLock = 7_150_002

// createDevice adds a device with the next free letter. It must run inside a
// transaction that holds enrollLock.
func createDevice(ctx context.Context, tx db.Querier, name string, enrolledBy *string) (Device, string, error) {
	var n int
	if err := tx.QueryRow(ctx, "SELECT count(*) FROM devices").Scan(&n); err != nil {
		return Device{}, "", err
	}
	d := Device{ID: newID(), Name: name, Code: deviceCode(n)}
	token, hash := NewToken()
	_, err := tx.Exec(ctx, `
		INSERT INTO devices (id, name, code, token_hash, enrolled_by) VALUES ($1, $2, $3, $4, $5)`,
		d.ID, d.Name, d.Code, hash, enrolledBy)
	if err != nil {
		return Device{}, "", fmt.Errorf("create device: %w", err)
	}
	return d, token, nil
}

func tooManyAttempts(wait time.Duration) error {
	return httpx.Errorf(http.StatusTooManyRequests, "too_many_attempts",
		"too many wrong attempts; try again in %d seconds", int(wait.Seconds())+1)
}

// Package httpx holds the small HTTP helpers every handler uses: JSON in and
// out, typed API errors, and middleware.
package httpx

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"runtime/debug"
	"time"
)

// Error is an API error: an HTTP status, a stable machine-readable code and a
// message for people.
type Error struct {
	Status  int    `json:"-"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *Error) Error() string { return e.Message }

// Errorf builds an *Error with a formatted message.
func Errorf(status int, code, format string, args ...any) *Error {
	return &Error{Status: status, Code: code, Message: fmt.Sprintf(format, args...)}
}

// Common errors.
var (
	ErrUnauthorized = &Error{Status: http.StatusUnauthorized, Code: "unauthorized", Message: "authentication required"}
	ErrForbidden    = &Error{Status: http.StatusForbidden, Code: "forbidden", Message: "not allowed"}
	ErrNotFound     = &Error{Status: http.StatusNotFound, Code: "not_found", Message: "not found"}
)

// BadRequest is shorthand for a 400 with code "invalid".
func BadRequest(format string, args ...any) *Error {
	return Errorf(http.StatusBadRequest, "invalid", format, args...)
}

// HandlerFunc is an http.Handler that returns an error instead of writing it.
type HandlerFunc func(w http.ResponseWriter, r *http.Request) error

func (f HandlerFunc) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if err := f(w, r); err != nil {
		WriteError(w, r, err)
	}
}

// WriteJSON writes v as a JSON response.
func WriteJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		slog.Warn("write json", "err", err)
	}
}

// WriteError writes err as a JSON error. Anything that isn't an *Error is
// logged and reported as a 500 without details.
func WriteError(w http.ResponseWriter, r *http.Request, err error) {
	var apiErr *Error
	if !errors.As(err, &apiErr) {
		slog.Error("request failed", "method", r.Method, "path", r.URL.Path, "err", err)
		apiErr = &Error{Status: http.StatusInternalServerError, Code: "internal", Message: "internal error"}
	}
	WriteJSON(w, apiErr.Status, apiErr)
}

// MaxBody is the largest request body any endpoint accepts.
const MaxBody = 4 << 20

// DecodeJSON decodes the request body into v, rejecting unknown fields and
// trailing data.
func DecodeJSON(w http.ResponseWriter, r *http.Request, v any) error {
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, MaxBody))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return BadRequest("invalid JSON body: %v", err)
	}
	if _, err := dec.Token(); err != io.EOF {
		return BadRequest("invalid JSON body: trailing data")
	}
	return nil
}

// Chain wraps h with middleware, outermost first.
func Chain(h http.Handler, middleware ...func(http.Handler) http.Handler) http.Handler {
	for i := len(middleware) - 1; i >= 0; i-- {
		h = middleware[i](h)
	}
	return h
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(status int) {
	r.status = status
	r.ResponseWriter.WriteHeader(status)
}

// LogRequests logs each API request with its status and duration. Static
// asset requests are not logged.
func LogRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		if len(r.URL.Path) >= 5 && r.URL.Path[:5] == "/api/" {
			slog.Info("request", "method", r.Method, "path", r.URL.Path,
				"status", rec.status, "ms", time.Since(start).Milliseconds())
		}
	})
}

// Recover turns a panic in a handler into a logged 500.
func Recover(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if v := recover(); v != nil {
				if v == http.ErrAbortHandler {
					panic(v)
				}
				slog.Error("panic", "path", r.URL.Path, "panic", v, "stack", string(debug.Stack()))
				WriteError(w, r, fmt.Errorf("panic: %v", v))
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// SecurityHeaders sets a strict content security policy and friends. The app
// loads nothing from other origins.
func SecurityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; "+
			"style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		next.ServeHTTP(w, r)
	})
}

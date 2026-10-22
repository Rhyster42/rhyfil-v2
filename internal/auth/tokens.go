package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"math/big"
	"strings"
	"sync"
	"time"
)

// NewToken returns a random 256-bit bearer token and the hash that is stored
// in place of it.
func NewToken() (token string, hash []byte) {
	b := make([]byte, 32)
	rand.Read(b)
	token = base64.RawURLEncoding.EncodeToString(b)
	return token, HashToken(token)
}

// HashToken returns the stored form of a token or one-time code.
func HashToken(token string) []byte {
	h := sha256.Sum256([]byte(token))
	return h[:]
}

// NewCode returns an 8-digit one-time code for setup or enrollment.
func NewCode() string {
	n, err := rand.Int(rand.Reader, big.NewInt(100_000_000))
	if err != nil {
		panic(err)
	}
	return fmt.Sprintf("%08d", n.Int64())
}

// FormatCode shows a code the way people read it aloud: 4831-2290.
func FormatCode(code string) string {
	if len(code) == 8 {
		return code[:4] + "-" + code[4:]
	}
	return code
}

// normalizeCode drops the spaces and dashes people type between groups.
func normalizeCode(s string) string {
	return strings.ToUpper(strings.Map(func(r rune) rune {
		if r == ' ' || r == '-' {
			return -1
		}
		return r
	}, s))
}

// deviceCode returns the order-number letter for the nth enrolled device:
// A … Z, AA, AB, … (docs/decisions/0011).
func deviceCode(n int) string {
	s := ""
	for n >= 0 {
		s = string(rune('A'+n%26)) + s
		n = n/26 - 1
	}
	return s
}

// limiter slows down guessing: after maxFailures wrong attempts on a key, the
// key is locked out, for twice as long on each repeat (capped at 15 minutes).
type limiter struct {
	mu          sync.Mutex
	entries     map[string]*limitEntry
	maxFailures int
	lockout     time.Duration
	now         func() time.Time
}

type limitEntry struct {
	failures int
	lockouts int
	until    time.Time
}

func newLimiter(maxFailures int, lockout time.Duration, now func() time.Time) *limiter {
	return &limiter{entries: map[string]*limitEntry{}, maxFailures: maxFailures, lockout: lockout, now: now}
}

// wait returns how long key is still locked out (0 if it isn't).
func (l *limiter) wait(key string) time.Duration {
	l.mu.Lock()
	defer l.mu.Unlock()
	if e := l.entries[key]; e != nil {
		if d := e.until.Sub(l.now()); d > 0 {
			return d
		}
	}
	return 0
}

func (l *limiter) fail(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	e := l.entries[key]
	if e == nil {
		e = &limitEntry{}
		l.entries[key] = e
	}
	e.failures++
	if e.failures >= l.maxFailures {
		e.failures = 0
		e.lockouts++
		d := l.lockout << min(e.lockouts-1, 10)
		e.until = l.now().Add(min(d, 15*time.Minute))
	}
}

func (l *limiter) reset(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.entries, key)
}

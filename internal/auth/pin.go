// Package auth handles device enrollment, staff PINs and manager sessions
// (docs/decisions/0010).
package auth

import (
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// PIN verifiers are "pbkdf2-sha256$<iterations>$<salt>$<hash>" with
// unpadded base64url salt and hash, so the browser can check them with
// WebCrypto (web/src/domain/pin.ts). Tested against testdata/vectors/pins.json.
const pinScheme = "pbkdf2-sha256"

// DefaultPINIterations takes roughly 50 ms on a recent tablet: slow enough to
// matter for 6+ digit PINs, fast enough for sign-in during a rush.
const DefaultPINIterations = 100_000

var pinPattern = regexp.MustCompile(`^[0-9]{4,8}$`)

// ValidPIN reports whether pin is 4 to 8 digits.
func ValidPIN(pin string) bool { return pinPattern.MatchString(pin) }

// HashPIN returns a new verifier for pin with a random salt.
func HashPIN(pin string, iterations int) (string, error) {
	salt := make([]byte, 16)
	rand.Read(salt)
	key, err := pbkdf2.Key(sha256.New, pin, salt, iterations, 32)
	if err != nil {
		return "", err
	}
	enc := base64.RawURLEncoding
	return fmt.Sprintf("%s$%d$%s$%s", pinScheme, iterations,
		enc.EncodeToString(salt), enc.EncodeToString(key)), nil
}

// VerifyPIN reports whether pin matches verifier. Malformed verifiers never
// match.
func VerifyPIN(verifier, pin string) bool {
	parts := strings.Split(verifier, "$")
	if len(parts) != 4 || parts[0] != pinScheme {
		return false
	}
	iterations, err := strconv.Atoi(parts[1])
	if err != nil || iterations < 1 || iterations > 10_000_000 {
		return false
	}
	enc := base64.RawURLEncoding
	salt, err := enc.DecodeString(parts[2])
	if err != nil {
		return false
	}
	want, err := enc.DecodeString(parts[3])
	if err != nil || len(want) == 0 {
		return false
	}
	got, err := pbkdf2.Key(sha256.New, pin, salt, iterations, len(want))
	if err != nil {
		return false
	}
	return subtle.ConstantTimeCompare(got, want) == 1
}

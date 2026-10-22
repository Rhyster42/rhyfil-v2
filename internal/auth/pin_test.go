package auth

import (
	"encoding/json"
	"os"
	"testing"
)

func TestPINVectors(t *testing.T) {
	b, err := os.ReadFile("../../testdata/vectors/pins.json")
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Cases []struct {
			Name, PIN, Verifier string
			Valid               bool
		}
	}
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	for _, tc := range v.Cases {
		if got := VerifyPIN(tc.Verifier, tc.PIN); got != tc.Valid {
			t.Errorf("%s: VerifyPIN = %v, want %v", tc.Name, got, tc.Valid)
		}
	}
}

func TestHashPINRoundTrip(t *testing.T) {
	v, err := HashPIN("482913", 1000)
	if err != nil {
		t.Fatal(err)
	}
	if !VerifyPIN(v, "482913") || VerifyPIN(v, "482914") {
		t.Fatal("round trip failed")
	}
	if v2, _ := HashPIN("482913", 1000); v2 == v {
		t.Fatal("two hashes of the same PIN should use different salts")
	}
}

func TestValidPIN(t *testing.T) {
	for pin, want := range map[string]bool{
		"1234": true, "00000000": true, "123": false, "123456789": false, "12a4": false, "": false, "١٢٣٤": false,
	} {
		if got := ValidPIN(pin); got != want {
			t.Errorf("ValidPIN(%q) = %v, want %v", pin, got, want)
		}
	}
}

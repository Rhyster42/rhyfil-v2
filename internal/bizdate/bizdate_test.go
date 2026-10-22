package bizdate

import (
	"encoding/json"
	"os"
	"testing"
	"time"
)

func TestBusinessDateVectors(t *testing.T) {
	b, err := os.ReadFile("../../testdata/vectors/business-dates.json")
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Cases []struct {
			Instant       time.Time
			TimeZone      string
			CutoffMinutes int
			Expect, Note  string
		}
	}
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	for _, tc := range v.Cases {
		loc, err := time.LoadLocation(tc.TimeZone)
		if err != nil {
			t.Fatal(err)
		}
		if got := Of(tc.Instant, loc, tc.CutoffMinutes); got != tc.Expect {
			t.Errorf("Of(%s, %s, %d) = %s, want %s (%s)",
				tc.Instant.Format(time.RFC3339), tc.TimeZone, tc.CutoffMinutes, got, tc.Expect, tc.Note)
		}
	}
}

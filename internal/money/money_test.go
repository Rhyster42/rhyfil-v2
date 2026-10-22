package money

import (
	"encoding/json"
	"math/rand/v2"
	"os"
	"slices"
	"testing"
)

type vectors struct {
	Tax []struct {
		Amount, PPM, Expect int64
		Note               string
	}
	Allocate []struct {
		Total   int64
		Weights []int64
		Expect  []int64
		Note    string
	}
}

func loadVectors(t *testing.T) vectors {
	t.Helper()
	b, err := os.ReadFile("../../testdata/vectors/money.json")
	if err != nil {
		t.Fatal(err)
	}
	var v vectors
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func TestTaxVectors(t *testing.T) {
	for _, tc := range loadVectors(t).Tax {
		if got := Tax(tc.Amount, tc.PPM); got != tc.Expect {
			t.Errorf("Tax(%d, %d) = %d, want %d (%s)", tc.Amount, tc.PPM, got, tc.Expect, tc.Note)
		}
	}
}

func TestTaxIsSymmetric(t *testing.T) {
	if got := Tax(-400, 88_750); got != -36 {
		t.Fatalf("Tax(-400) = %d, want -36", got)
	}
}

func TestAllocateVectors(t *testing.T) {
	for _, tc := range loadVectors(t).Allocate {
		if got := Allocate(tc.Total, tc.Weights); !slices.Equal(got, tc.Expect) {
			t.Errorf("Allocate(%d, %v) = %v, want %v (%s)", tc.Total, tc.Weights, got, tc.Expect, tc.Note)
		}
	}
}

// The parts of an allocation always add up to the whole, and no part is more
// than a cent away from its exact share.
func TestAllocateProperties(t *testing.T) {
	r := rand.New(rand.NewPCG(1, 2))
	for range 5000 {
		total := r.Int64N(1_000_000)
		weights := make([]int64, 1+r.IntN(8))
		var sum int64
		for i := range weights {
			if r.IntN(4) > 0 {
				weights[i] = r.Int64N(10_000)
			}
			sum += weights[i]
		}
		parts := Allocate(total, weights)
		if Sum(parts) != total {
			t.Fatalf("Allocate(%d, %v) = %v sums to %d", total, weights, parts, Sum(parts))
		}
		if sum == 0 {
			continue
		}
		for i, p := range parts {
			exact := float64(total) * float64(weights[i]) / float64(sum)
			if float64(p) < exact-1 || float64(p) > exact+1 {
				t.Fatalf("Allocate(%d, %v)[%d] = %d, exact share %.2f", total, weights, i, p, exact)
			}
		}
	}
}

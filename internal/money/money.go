// Package money holds the integer-cent arithmetic behind tax, split checks and
// refunds. It mirrors web/src/domain/money.ts; both are tested against
// testdata/vectors/money.json (docs/decisions/0006).
package money

import (
	"math/bits"
	"sort"
)

// PPM is a whole rate (100%) in parts per million.
const PPM = 1_000_000

// Tax returns amount × ratePPM / 1,000,000, rounded half away from zero.
func Tax(amount, ratePPM int64) int64 {
	if amount < 0 {
		return -Tax(-amount, ratePPM)
	}
	return (amount*ratePPM + PPM/2) / PPM
}

// Allocate splits total into len(weights) parts in proportion to weights.
// Each part gets the floor of its exact share; the cents left over go one
// each to the parts with the largest remainders, earlier parts winning ties.
// The parts always sum to total. If every weight is zero, total is split
// evenly. Negative inputs are a programming error and panic.
func Allocate(total int64, weights []int64) []int64 {
	n := len(weights)
	parts := make([]int64, n)
	if n == 0 {
		return parts
	}
	if total < 0 {
		panic("money.Allocate: negative total")
	}
	var sum uint64
	for _, w := range weights {
		if w < 0 {
			panic("money.Allocate: negative weight")
		}
		sum += uint64(w)
	}
	if sum == 0 {
		weights = make([]int64, n)
		for i := range weights {
			weights[i] = 1
		}
		sum = uint64(n)
	}

	remainders := make([]uint64, n)
	order := make([]int, n)
	left := total
	for i, w := range weights {
		// total × w can exceed 64 bits; the quotient can't (w ≤ sum).
		hi, lo := bits.Mul64(uint64(total), uint64(w))
		q, r := bits.Div64(hi, lo, sum)
		parts[i] = int64(q)
		remainders[i] = r
		order[i] = i
		left -= int64(q)
	}
	sort.SliceStable(order, func(a, b int) bool {
		return remainders[order[a]] > remainders[order[b]]
	})
	for k := int64(0); k < left; k++ {
		parts[order[k]]++
	}
	return parts
}

// Sum adds amounts.
func Sum(amounts []int64) int64 {
	var s int64
	for _, a := range amounts {
		s += a
	}
	return s
}

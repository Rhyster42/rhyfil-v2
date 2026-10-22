// Package bizdate assigns moments to business days. It mirrors
// web/src/domain/businessDate.ts; both are tested against
// testdata/vectors/business-dates.json (docs/decisions/0013).
package bizdate

import (
	"fmt"
	"time"
)

// Layout is the wire format of a business date.
const Layout = "2006-01-02"

// Of returns the business date of t: its calendar date in loc, or the
// previous date if the local time is earlier than cutoffMinutes past
// midnight. Comparing wall-clock minutes (rather than subtracting a duration)
// keeps the rule simple across daylight-saving changes.
func Of(t time.Time, loc *time.Location, cutoffMinutes int) string {
	local := t.In(loc)
	y, m, d := local.Date()
	if local.Hour()*60+local.Minute() < cutoffMinutes {
		y, m, d = time.Date(y, m, d-1, 12, 0, 0, 0, time.UTC).Date()
	}
	return fmt.Sprintf("%04d-%02d-%02d", y, m, d)
}

// Parse checks that s is a business date and returns it as midnight UTC.
func Parse(s string) (time.Time, error) {
	return time.Parse(Layout, s)
}

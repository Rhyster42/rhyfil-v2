package server_test

import (
	"io"
	"log/slog"
	"os"
	"testing"
)

// Request logs drown out test failures; set POS_TEST_LOGS=1 to see them.
func TestMain(m *testing.M) {
	if os.Getenv("POS_TEST_LOGS") == "" {
		slog.SetDefault(slog.New(slog.NewTextHandler(io.Discard, nil)))
	}
	os.Exit(m.Run())
}

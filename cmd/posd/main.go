// Command posd is the coffee POS server: it serves the API and the PWA.
//
//	posd [serve]   run the server (migrates the database first)
//	posd migrate   apply migrations and exit
//	posd health    exit 0 if the local server's /healthz is OK (for Docker)
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
	_ "time/tzdata" // store time zones must resolve even in a distroless image

	"coffeepos/internal/auth"
	"coffeepos/internal/db"
	"coffeepos/internal/seed"
	"coffeepos/internal/server"
)

func main() {
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, nil)))
	cmd := "serve"
	if len(os.Args) > 1 {
		cmd = os.Args[1]
	}
	var err error
	switch cmd {
	case "serve":
		err = serve()
	case "migrate":
		err = migrate()
	case "health":
		err = health()
	default:
		err = fmt.Errorf("unknown command %q (want serve, migrate or health)", cmd)
	}
	if err != nil {
		slog.Error("posd", "err", err)
		os.Exit(1)
	}
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func serve() error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		return errors.New("DATABASE_URL is required")
	}
	pool, err := db.Open(ctx, dbURL)
	if err != nil {
		return err
	}
	defer pool.Close()
	if err := db.Migrate(ctx, pool); err != nil {
		return err
	}

	if os.Getenv("POS_DEMO") == "1" {
		seeded, err := seed.Demo(ctx, pool, auth.DefaultPINIterations)
		if err != nil {
			return err
		}
		if seeded {
			slog.Info("loaded demo data: Morgan (manager, PIN 1234), Sam (1111), Riley (2222)")
		}
	}

	demoCode := os.Getenv("POS_DEMO_ENROLL_CODE")
	app := server.New(server.Config{
		Pool:   pool,
		WebDir: env("POS_WEB_DIR", "web/dist"),
		Auth:   auth.Options{DemoEnrollCode: demoCode},
	})
	if demoCode != "" {
		slog.Warn("demo enrollment code is on: anyone who knows it can enroll a device", "code", demoCode)
	}
	if code, err := app.Auth.EnsureSetupCode(ctx); err != nil {
		return err
	} else if code != "" {
		slog.Warn("first run: open the app and set it up with this code", "code", auth.FormatCode(code))
	}

	addr := env("POS_ADDR", ":8080")
	srv := &http.Server{
		Addr:              addr,
		Handler:           app.Handler,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	errc := make(chan error, 1)
	go func() {
		slog.Info("listening", "addr", addr)
		errc <- srv.ListenAndServe()
	}()
	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
	}
	slog.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return srv.Shutdown(shutdownCtx)
}

func migrate() error {
	ctx := context.Background()
	pool, err := db.Open(ctx, os.Getenv("DATABASE_URL"))
	if err != nil {
		return err
	}
	defer pool.Close()
	return db.Migrate(ctx, pool)
}

func health() error {
	port := env("POS_ADDR", ":8080")
	port = port[strings.LastIndex(port, ":")+1:]
	client := http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get("http://127.0.0.1:" + port + "/healthz")
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("healthz returned %s", resp.Status)
	}
	return nil
}

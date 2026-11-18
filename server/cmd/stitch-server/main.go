package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/mjvanraaphorst/stash-stitch/server/internal/stitch"
)

func main() {
	config := flag.String("config", "stitch-server.json", "configuration JSON file")
	version := flag.Bool("version", false, "print version")
	key := flag.Bool("generate-key", false, "print a random companion service key")
	check := flag.Bool("check", false, "validate configuration and Stash connection, then exit")
	flag.Parse()
	if *version {
		fmt.Println(stitch.Version)
		return
	}
	if *key {
		b := make([]byte, 32)
		if _, e := rand.Read(b); e != nil {
			log.Fatal(e)
		}
		fmt.Println(hex.EncodeToString(b))
		return
	}
	cfg, e := stitch.LoadConfig(*config)
	if e != nil {
		log.Fatal(e)
	}
	s, e := stitch.New(cfg)
	if e != nil {
		log.Fatal(e)
	}
	defer s.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	e = s.Ready(ctx)
	cancel()
	if e != nil {
		log.Fatal(e)
	}
	if *check {
		fmt.Println("Configuration and Stash API connection OK; no media prepared.")
		return
	}
	httpServer := &http.Server{Addr: cfg.Listen, Handler: s, ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 30 * time.Second, IdleTimeout: 90 * time.Second, MaxHeaderBytes: 1 << 20}
	stopped := make(chan os.Signal, 1)
	signal.Notify(stopped, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-stopped
		s.Close()
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(ctx)
	}()
	log.Printf("Stash Stitch %s listening on %s (stream copy only)", stitch.Version, cfg.Listen)
	if e = httpServer.ListenAndServe(); e != nil && e != http.ErrServerClosed {
		log.Fatal(e)
	}
}

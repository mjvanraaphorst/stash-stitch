package stitch

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

const Version = "0.3.0-preview.2"

type Config struct {
	Listen                string `json:"listen"`
	PublicURL             string `json:"public_url"`
	StashURL              string `json:"stash_url"`
	StashAPIKey           string `json:"stash_api_key"`
	ServiceKey            string `json:"service_key"`
	CacheDir              string `json:"cache_dir"`
	FFmpeg                string `json:"ffmpeg"`
	FFprobe               string `json:"ffprobe"`
	MaxCacheBytes         int64  `json:"max_cache_bytes"`
	MaxDownloadBytes      int64  `json:"max_download_bytes"`
	MaxScenes             int    `json:"max_scenes"`
	PrepareTimeoutSeconds int    `json:"prepare_timeout_seconds"`
	MediaTokenHours       int    `json:"media_token_hours"`
}

func LoadConfig(path string) (Config, error) {
	c := Config{Listen: "127.0.0.1:9998", FFmpeg: "ffmpeg", FFprobe: "ffprobe", MaxCacheBytes: 50 << 30, MaxDownloadBytes: 20 << 30, MaxScenes: 20000, PrepareTimeoutSeconds: 3600, MediaTokenHours: 24}
	b, e := os.ReadFile(path)
	if e != nil {
		return c, e
	}
	d := json.NewDecoder(strings.NewReader(string(b)))
	d.DisallowUnknownFields()
	if e = d.Decode(&c); e != nil {
		return c, e
	}
	if v := os.Getenv("STITCH_STASH_API_KEY"); v != "" {
		c.StashAPIKey = v
	}
	if v := os.Getenv("STITCH_SERVICE_KEY"); v != "" {
		c.ServiceKey = v
	}
	if c.CacheDir == "" {
		root, e := os.UserCacheDir()
		if e != nil {
			return c, e
		}
		c.CacheDir = filepath.Join(root, "stash-stitch")
	}
	if !filepath.IsAbs(c.CacheDir) {
		c.CacheDir = filepath.Join(filepath.Dir(path), c.CacheDir)
	}
	return c, c.Validate()
}
func (c Config) Validate() error {
	for _, s := range []string{c.PublicURL, c.StashURL} {
		u, e := url.Parse(s)
		if e != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
			return errors.New("public_url and stash_url must be HTTP(S) URLs without credentials or query strings")
		}
	}
	p, _ := url.Parse(c.PublicURL)
	if p.Path != "" && p.Path != "/" {
		return errors.New("public_url must use the root path")
	}
	if len(c.ServiceKey) < 24 || strings.HasPrefix(c.ServiceKey, "CHANGE") {
		return errors.New("set service_key (at least 24 random characters), or STITCH_SERVICE_KEY")
	}
	if c.MaxCacheBytes < 1 || c.MaxDownloadBytes < 1 || c.MaxScenes < 1 || c.PrepareTimeoutSeconds < 1 || c.MediaTokenHours < 1 || c.MediaTokenHours > 168 {
		return fmt.Errorf("cache, scene, timeout and token limits must be positive (tokens at most 168 hours)")
	}
	return nil
}

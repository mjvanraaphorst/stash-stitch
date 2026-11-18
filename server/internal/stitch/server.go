package stitch

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type Server struct {
	cfg          Config
	up           *Upstream
	catalogCache catalogCache
	media        *mediaCache
	activity     activityStore
	proxy        *httputil.ReverseProxy
}

func New(c Config) (*Server, error) {
	if e := c.Validate(); e != nil {
		return nil, e
	}
	if e := os.MkdirAll(c.CacheDir, 0700); e != nil {
		return nil, e
	}
	s := &Server{cfg: c, up: newUpstream(c)}
	if e := s.activity.load(statePath(c.CacheDir)); e != nil {
		return nil, fmt.Errorf("cannot load playback state: %w", e)
	}
	s.media = newMediaCache(s)
	s.proxy = &httputil.ReverseProxy{Rewrite: func(pr *httputil.ProxyRequest) {
		pr.SetURL(s.up.base)
		pr.Out.Host = s.up.base.Host
		pr.Out.Header.Del("Cookie")
		pr.Out.Header.Del("Authorization")
		pr.Out.Header.Del("ApiKey")
		pr.Out.Header.Del("X-Forwarded-Host")
		pr.Out.Header.Del("X-Forwarded-Proto")
		pr.Out.Header.Del("X-Forwarded-For")
		if s.up.key != "" {
			pr.Out.Header.Set("ApiKey", s.up.key)
		}
		q := pr.Out.URL.Query()
		q.Del("apikey")
		q.Del("token")
		pr.Out.URL.RawQuery = q.Encode()
	}, ModifyResponse: func(r *http.Response) error {
		r.Header.Del("Set-Cookie")
		r.Header.Set("X-Stash-Stitch", Version)
		if loc := r.Header.Get("Location"); loc != "" {
			u, e := url.Parse(loc)
			if e == nil && u.IsAbs() {
				r.Header.Set("Location", s.rewriteURL(loc))
			}
		}
		ct := r.Header.Get("Content-Type")
		if strings.Contains(ct, "text/html") {
			b, e := io.ReadAll(io.LimitReader(r.Body, 8<<20))
			r.Body.Close()
			if e != nil {
				return e
			}
			inject := `<script src="/stitch/bootstrap.js"></script>`
			body := strings.Replace(string(b), "<head>", "<head>"+inject, 1)
			r.Body = io.NopCloser(strings.NewReader(body))
			r.ContentLength = int64(len(body))
			r.Header.Set("Content-Length", strconv.Itoa(len(body)))
			r.Header.Del("Content-Encoding")
		}
		return nil
	}, ErrorHandler: func(w http.ResponseWriter, r *http.Request, e error) { http.Error(w, "Stash is unavailable", 502) }}
	return s, nil
}
func (s *Server) Close() { s.media.cancel() }
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("X-Stash-Stitch", Version)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if r.URL.Path == "/healthz" {
		writeJSON(w, object{"status": "ok", "version": Version})
		return
	}
	// Media URLs carry a narrowly scoped signature for receivers without API headers.
	if strings.HasPrefix(r.URL.Path, "/stitch/hls/") {
		s.serveHLS(w, r)
		return
	}
	if !s.authorized(r) {
		http.Error(w, "Stitch authentication required. Use the companion service key as the client's API key.", 401)
		return
	}
	if r.Method == "GET" && r.URL.Query().Get("apikey") != "" && r.URL.Path != "/graphql" {
		http.SetCookie(w, &http.Cookie{Name: "stitch_session", Value: s.cfg.ServiceKey, Path: "/", HttpOnly: true, SameSite: http.SameSiteLaxMode, Secure: strings.HasPrefix(s.cfg.PublicURL, "https://"), MaxAge: 86400 * 7})
		q := r.URL.Query()
		q.Del("apikey")
		u := *r.URL
		u.RawQuery = q.Encode()
		http.Redirect(w, r, u.String(), http.StatusSeeOther)
		return
	}
	if s.redirectLegacyGroup(w, r) {
		return
	}
	switch {
	case r.URL.Path == "/stitch/bootstrap.js":
		w.Header().Set("Content-Type", "application/javascript")
		_, _ = io.WriteString(w, "window.__STASH_STITCH_PROXY__=true;")
	case r.URL.Path == "/graphql":
		if strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
			r.Header.Set("Origin", s.up.base.Scheme+"://"+s.up.base.Host)
			s.proxy.ServeHTTP(w, r)
		} else {
			s.graphql(w, r)
		}
	case r.URL.Path == "/stitch/info":
		writeJSON(w, object{"version": Version, "library": "virtual-scenes", "transcoding": false, "media_access": "stash-only"})
	case strings.HasPrefix(r.URL.Path, "/stitch/groups/"):
		s.groupStatus(w, r)
	default:
		if r.Method != "GET" && r.Method != "HEAD" {
			http.Error(w, "use the GraphQL API for writes", 405)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/scene/") && strings.Contains(r.URL.Path, "/stream") && r.URL.Query().Get("start") != "" {
			http.Error(w, "companion does not start transcoding jobs", 400)
			return
		}
		r.Header.Set("Accept-Encoding", "identity")
		s.proxy.ServeHTTP(w, r)
	}
}

// Existing bookmarks and links from other applications use the browser-only
// /scenes/<original>?stitch=<group> route. On the companion origin these must
// resolve to a virtual scene, so refreshing an old tab cannot play one chapter.
func (s *Server) redirectLegacyGroup(w http.ResponseWriter, r *http.Request) bool {
	if r.Method != "GET" && r.Method != "HEAD" {
		return false
	}
	id := ""
	original := ""
	if strings.HasPrefix(r.URL.Path, "/scenes/") {
		original = strings.TrimPrefix(r.URL.Path, "/scenes/")
		if _, e := strconv.ParseUint(original, 10, 64); e != nil {
			return false
		}
		id = r.URL.Query().Get("stitch")
	} else if strings.HasPrefix(r.URL.Path, "/plugins/stash-stitch/group/") {
		id = strings.TrimPrefix(r.URL.Path, "/plugins/stash-stitch/group/")
	}
	if _, e := strconv.ParseUint(id, 10, 64); e != nil {
		return false
	}
	cat, e := s.catalog(r.Context())
	if e != nil {
		http.Error(w, e.Error(), http.StatusBadGateway)
		return true
	}
	group := cat.Groups[id]
	if group == nil {
		http.Error(w, "group is missing or unavailable for grouped playback", http.StatusNotFound)
		return true
	}
	if original != "" {
		found := false
		for _, ch := range group.Chapters {
			if ch.ID == original {
				found = true
				break
			}
		}
		if !found {
			http.Error(w, "scene is not a chapter of this group", http.StatusNotFound)
			return true
		}
	}
	u := *r.URL
	u.Path = "/scenes/" + group.VirtualID()
	u.RawPath = ""
	q := u.Query()
	q.Del("stitch")
	u.RawQuery = q.Encode()
	http.Redirect(w, r, u.String(), http.StatusSeeOther)
	return true
}
func (s *Server) authorized(r *http.Request) bool {
	token := r.Header.Get("ApiKey")
	if token == "" {
		token = strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	}
	if token == "" {
		token = r.URL.Query().Get("apikey")
	}
	if token == "" {
		if c, e := r.Cookie("stitch_session"); e == nil {
			token = c.Value
		}
	}
	return subtle.ConstantTimeCompare([]byte(token), []byte(s.cfg.ServiceKey)) == 1
}
func (s *Server) signature(scope, expires string) string {
	h := hmac.New(sha256.New, []byte(s.cfg.ServiceKey))
	_, _ = io.WriteString(h, scope+"\n"+expires)
	return hex.EncodeToString(h.Sum(nil))
}
func (s *Server) signedURL(path, scope string, expiry int64) string {
	e := strconv.FormatInt(expiry, 10)
	return strings.TrimRight(s.cfg.PublicURL, "/") + path + "?expires=" + e + "&signature=" + s.signature(scope, e)
}
func (s *Server) validSignature(r *http.Request, scope string) bool {
	e := r.URL.Query().Get("expires")
	n, err := strconv.ParseInt(e, 10, 64)
	if err != nil || n < time.Now().Unix() || n > time.Now().Add(169*time.Hour).Unix() {
		return false
	}
	return hmac.Equal([]byte(r.URL.Query().Get("signature")), []byte(s.signature(scope, e)))
}
func (s *Server) playbackURL(g *Group) string {
	scope := g.ID + "/" + g.Revision
	return s.signedURL("/stitch/hls/"+scope+"/stream.m3u8", scope, time.Now().Add(time.Duration(s.cfg.MediaTokenHours)*time.Hour).Unix())
}
func (s *Server) rewriteURL(raw string) string {
	u, e := url.Parse(raw)
	if e != nil || !u.IsAbs() || !strings.EqualFold(u.Host, s.up.base.Host) || u.Scheme != s.up.base.Scheme {
		return raw
	}
	prefix := strings.TrimRight(s.up.base.Path, "/")
	if !strings.HasPrefix(u.Path, prefix+"/") {
		return raw
	}
	p := strings.TrimPrefix(u.Path, prefix)
	q := u.Query()
	q.Del("apikey")
	q.Del("token")
	u.RawQuery = q.Encode()
	pub, _ := url.Parse(s.cfg.PublicURL)
	u.Scheme = pub.Scheme
	u.Host = pub.Host
	u.Path = p
	return u.String()
}
func (s *Server) rewriteURLs(v any) {
	switch x := v.(type) {
	case object:
		for k, v := range x {
			if text, ok := v.(string); ok {
				x[k] = s.rewriteURL(text)
			} else {
				s.rewriteURLs(v)
			}
		}
	case []any:
		for i, v := range x {
			if text, ok := v.(string); ok {
				x[i] = s.rewriteURL(text)
			} else {
				s.rewriteURLs(v)
			}
		}
	}
}
func (s *Server) groupStatus(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/stitch/groups/")
	if strings.Contains(id, "/") || id == "" {
		http.NotFound(w, r)
		return
	}
	cat, e := s.catalog(r.Context())
	if e != nil {
		http.Error(w, e.Error(), 502)
		return
	}
	g := cat.Groups[id]
	if g == nil {
		http.NotFound(w, r)
		return
	}
	if r.Method == "POST" {
		s.media.start(g)
	} else if r.Method != "GET" {
		http.Error(w, "method not allowed", 405)
		return
	}
	status := s.media.status(g)
	status["id"] = g.VirtualID()
	status["chapter_count"] = len(g.Chapters)
	chapters := []object{}
	start := 0.0
	durations := s.media.durations(g)
	for i, ch := range g.Chapters {
		chapters = append(chapters, object{"scene_id": ch.ID, "start": start, "duration": durations[i]})
		start += durations[i]
	}
	status["chapters"] = chapters
	status["duration"] = start
	status["playback_url"] = s.playbackURL(g)
	writeJSON(w, status)
}
func (s *Server) serveHLS(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" && r.Method != "HEAD" {
		http.Error(w, "method not allowed", 405)
		return
	}
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/stitch/hls/"), "/")
	if len(parts) < 3 {
		http.NotFound(w, r)
		return
	}
	id, revision := parts[0], parts[1]
	scope := id + "/" + revision
	if !s.authorized(r) && !s.validSignature(r, scope) {
		http.Error(w, "media link expired or invalid", 401)
		return
	}
	cat, e := s.catalog(r.Context())
	if e != nil {
		http.Error(w, e.Error(), 502)
		return
	}
	g := cat.Groups[id]
	if g == nil || g.Revision != revision {
		http.Error(w, "group changed; reload its scene to get a new stream", 410)
		return
	}
	entry := s.media.start(g)
	select {
	case <-entry.done:
	case <-r.Context().Done():
		return
	}
	if entry.err != nil {
		http.Error(w, entry.err.Error(), http.StatusUnprocessableEntity)
		return
	}
	// Pin cached files while serving and prevent cache eviction during active reads.
	release, e := s.media.pin(entry)
	if e != nil {
		http.Error(w, "cached group was evicted; reload playback", 410)
		return
	}
	defer release()
	name := strings.Join(parts[2:], "/")
	if name == "stream.m3u8" {
		expiry := time.Now().Add(time.Duration(s.cfg.MediaTokenHours) * time.Hour).Unix()
		text := entry.manifest
		lines := strings.Split(text, "\n")
		for i, line := range lines {
			if strings.HasPrefix(line, "#EXT-X-MAP:") {
				start := strings.Index(line, `URI="`)
				if start >= 0 {
					end := strings.Index(line[start+5:], `"`)
					if end >= 0 {
						path := line[start+5 : start+5+end]
						lines[i] = line[:start+5] + s.signedURL("/stitch/hls/"+scope+"/"+path, scope, expiry) + line[start+5+end:]
					}
				}
			} else if line != "" && !strings.HasPrefix(line, "#") {
				lines[i] = s.signedURL("/stitch/hls/"+scope+"/"+line, scope, expiry)
			}
		}
		w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
		w.Header().Set("Cache-Control", "private, max-age=60")
		if r.Method != "HEAD" {
			_, _ = io.WriteString(w, strings.Join(lines, "\n"))
		}
		return
	}
	clean := filepath.Clean(name)
	if clean != name || strings.Contains(name, "\\") || strings.HasPrefix(clean, ".") || !entry.files[name] {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "video/mp4")
	w.Header().Set("Cache-Control", "private, max-age=3600")
	http.ServeFile(w, r, filepath.Join(entry.dir, filepath.FromSlash(name)))
}
func (s *Server) Ready(ctx context.Context) error {
	_, e := s.up.data(ctx, `query{version{version}}`)
	if e != nil {
		return errors.New("cannot read Stash API; verify stash_url and stash_api_key")
	}
	return nil
}

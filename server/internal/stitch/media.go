package stitch

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

type mediaEntry struct {
	dir, manifest    string
	files            map[string]bool
	done             chan struct{}
	err              error
	bytes            int64
	last             time.Time
	pins             int
	ready            bool
	progress         string
	chapterDurations []float64
}
type mediaCache struct {
	s       *Server
	mu      sync.Mutex
	entries map[string]*mediaEntry
	sem     chan struct{}
	ctx     context.Context
	cancel  context.CancelFunc
	root    string
}
type persistedMedia struct {
	Manifest         string          `json:"manifest"`
	Files            map[string]bool `json:"files"`
	Bytes            int64           `json:"bytes"`
	ChapterDurations []float64       `json:"chapter_durations"`
}

func newMediaCache(s *Server) *mediaCache {
	ctx, cancel := context.WithCancel(context.Background())
	m := &mediaCache{s: s, entries: map[string]*mediaEntry{}, sem: make(chan struct{}, 1), ctx: ctx, cancel: cancel, root: filepath.Join(s.cfg.CacheDir, "media")}
	return m
}
func (m *mediaCache) start(g *Group) *mediaEntry {
	m.mu.Lock()
	defer m.mu.Unlock()
	key := g.ID + "-" + g.Revision
	if e := m.entries[key]; e != nil {
		if !e.ready || e.err == nil || time.Since(e.last) < 10*time.Second {
			e.last = time.Now()
			return e
		}
		delete(m.entries, key)
	}
	e := &mediaEntry{dir: filepath.Join(m.root, key), files: map[string]bool{}, done: make(chan struct{}), last: time.Now(), progress: "queued"}
	m.entries[key] = e
	running := 0
	for _, v := range m.entries {
		if !v.ready {
			running++
		}
	}
	if running > 8 {
		e.err = errors.New("preparation queue is full; restart preparation later")
		e.ready = true
		close(e.done)
		return e
	}
	go func() {
		ctx, cancel := context.WithTimeout(m.ctx, time.Duration(m.s.cfg.PrepareTimeoutSeconds)*time.Second)
		defer cancel()
		var err error
		select {
		case m.sem <- struct{}{}:
			defer func() { <-m.sem }()
			err = m.prepare(ctx, g, e)
		case <-ctx.Done():
			err = errors.New("group preparation timed out or server stopped")
		}
		m.mu.Lock()
		e.err = err
		e.ready = true
		e.last = time.Now()
		if err != nil {
			e.progress = "failed"
		} else {
			e.progress = "ready"
		}
		close(e.done)
		m.mu.Unlock()
	}()
	return e
}
func (m *mediaCache) status(g *Group) object {
	m.mu.Lock()
	defer m.mu.Unlock()
	e := m.entries[g.ID+"-"+g.Revision]
	if e == nil {
		return object{"status": "not_prepared"}
	}
	o := object{"status": e.progress}
	if e.err != nil {
		o["error"] = e.err.Error()
	}
	return o
}

func (m *mediaCache) durations(g *Group) []float64 {
	m.mu.Lock()
	defer m.mu.Unlock()
	e := m.entries[g.ID+"-"+g.Revision]
	if e != nil && e.ready && e.err == nil && len(e.chapterDurations) == len(g.Chapters) {
		return append([]float64{}, e.chapterDurations...)
	}
	out := []float64{}
	for _, ch := range g.Chapters {
		out = append(out, ch.Duration)
	}
	return out
}
func (s *Server) duration(g *Group) float64 {
	total := 0.0
	for _, d := range s.media.durations(g) {
		total += d
	}
	return total
}
func (m *mediaCache) progress(e *mediaEntry, p string) { m.mu.Lock(); e.progress = p; m.mu.Unlock() }
func (m *mediaCache) pin(e *mediaEntry) (func(), error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, err := os.Stat(filepath.Join(e.dir, "ready.json")); err != nil {
		return nil, err
	}
	e.pins++
	e.last = time.Now()
	return func() { m.mu.Lock(); e.pins--; e.last = time.Now(); m.mu.Unlock() }, nil
}
func directoryBytes(path string) int64 {
	var n int64
	_ = filepath.WalkDir(path, func(_ string, d os.DirEntry, e error) error {
		if e == nil && !d.IsDir() {
			if i, e := d.Info(); e == nil {
				n += i.Size()
			}
		}
		return nil
	})
	return n
}
func (m *mediaCache) reserve(current *mediaEntry, needed int64) error {
	if needed > m.s.cfg.MaxCacheBytes {
		return errors.New("group exceeds cache budget; raise max_cache_bytes")
	}
	if err := os.MkdirAll(m.root, 0700); err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	dirs, _ := os.ReadDir(m.root)
	used := directoryBytes(m.root)
	for used+needed > m.s.cfg.MaxCacheBytes {
		var oldest string
		var when time.Time
		for _, dir := range dirs {
			path := filepath.Join(m.root, dir.Name())
			if !dir.IsDir() || path == current.dir {
				continue
			}
			e := m.entries[dir.Name()]
			if e != nil && (!e.ready || e.pins > 0 || time.Since(e.last) < 30*time.Minute) {
				continue
			}
			info, err := dir.Info()
			if err != nil {
				continue
			}
			stamp := info.ModTime()
			if e != nil {
				stamp = e.last
			}
			if oldest == "" || stamp.Before(when) {
				oldest = path
				when = stamp
			}
		}
		if oldest == "" {
			return errors.New("cache budget is in use; retry later or raise max_cache_bytes")
		}
		n := directoryBytes(oldest)
		if err := os.RemoveAll(oldest); err != nil {
			return err
		}
		delete(m.entries, filepath.Base(oldest))
		used -= n
		next := dirs[:0]
		for _, dir := range dirs {
			if filepath.Join(m.root, dir.Name()) != oldest {
				next = append(next, dir)
			}
		}
		dirs = next
	}
	return nil
}
func (m *mediaCache) prepare(ctx context.Context, g *Group, e *mediaEntry) (err error) {
	// Cached outputs survive restart. Originals are never needed outside Stash HTTP.
	if b, readErr := os.ReadFile(filepath.Join(e.dir, "ready.json")); readErr == nil {
		var p persistedMedia
		if json.Unmarshal(b, &p) == nil && p.Manifest != "" {
			valid := len(p.ChapterDurations) == len(g.Chapters)
			for name := range p.Files {
				if filepath.Clean(name) != name || strings.HasPrefix(name, ".") || strings.Contains(name, "\\") {
					valid = false
					break
				}
				if i, err := os.Lstat(filepath.Join(e.dir, name)); err != nil || !i.Mode().IsRegular() {
					valid = false
					break
				}
			}
			if valid {
				e.manifest = p.Manifest
				e.files = p.Files
				e.bytes = p.Bytes
				e.chapterDurations = p.ChapterDurations
				return nil
			}
		}
	}
	needed := g.Size*2 + 64<<20
	if g.Size <= 0 {
		needed = m.s.cfg.MaxDownloadBytes
	}
	if err = m.reserve(e, needed); err != nil {
		return err
	}
	if err = os.RemoveAll(e.dir); err != nil {
		return err
	}
	if err = os.MkdirAll(e.dir, 0700); err != nil {
		return err
	}
	defer func() {
		if err != nil {
			_ = os.RemoveAll(e.dir)
		}
	}()
	for _, binary := range []string{m.s.cfg.FFmpeg, m.s.cfg.FFprobe} {
		if _, err = exec.LookPath(binary); err != nil {
			return errors.New("install ffmpeg and ffprobe, or configure their executable paths")
		}
	}
	segments := []chapterManifest{}
	var signature string
	for i, ch := range g.Chapters {
		if ctx.Err() != nil {
			return errors.New("group preparation timed out or server stopped")
		}
		m.progress(e, fmt.Sprintf("preparing chapter %d of %d", i+1, len(g.Chapters)))
		dir := filepath.Join(e.dir, strconv.Itoa(i))
		if err = os.MkdirAll(dir, 0700); err != nil {
			return err
		}
		source := filepath.Join(dir, "source.media")
		if err = m.download(ctx, ch.ID, source); err != nil {
			return err
		}
		var probe probeResult
		probe, err = m.probe(ctx, source)
		if err != nil {
			return err
		}
		sig := probe.signature()
		if i == 0 {
			signature = sig
		} else if signature != sig {
			return errors.New("chapters use different video/audio codecs or audio layouts; no transcoding was performed")
		}
		// FFmpeg reads a downloaded original, never the user's library filesystem.
		// Stream-copy is mandatory, and network protocols are disabled for this step.
		args := []string{"-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-protocol_whitelist", "file,pipe", "-i", source, "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy"}
		if probe.videoCodec() == "hevc" {
			args = append(args, "-tag:v", "hvc1")
		}
		args = append(args, "-f", "hls", "-hls_time", "4", "-hls_playlist_type", "vod", "-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", "init.mp4", "-hls_segment_filename", filepath.Join(dir, "segment-%06d.m4s"), filepath.Join(dir, "chapter.m3u8"))
		cmd := exec.CommandContext(ctx, m.s.cfg.FFmpeg, args...)
		if err = cmd.Run(); err != nil {
			return errors.New("stream-copy packaging failed; the source may require transcoding, which is disabled")
		}
		if err = os.Remove(source); err != nil {
			return err
		}
		b, readErr := os.ReadFile(filepath.Join(dir, "chapter.m3u8"))
		if readErr != nil {
			return readErr
		}
		var cm chapterManifest
		cm, err = parseChapterManifest(string(b), strconv.Itoa(i))
		if err != nil {
			return err
		}
		segments = append(segments, cm)
		e.chapterDurations = append(e.chapterDurations, cm.duration)
		e.files[strconv.Itoa(i)+"/init.mp4"] = true
		for _, name := range cm.files {
			e.files[name] = true
		}
		if directoryBytes(e.dir) > m.s.cfg.MaxCacheBytes {
			return errors.New("packaged group exceeded cache budget")
		}
	}
	e.manifest = combineManifests(segments)
	e.bytes = directoryBytes(e.dir)
	p, _ := json.Marshal(persistedMedia{e.manifest, e.files, e.bytes, e.chapterDurations})
	if err = os.WriteFile(filepath.Join(e.dir, "ready.json"), p, 0600); err != nil {
		return err
	}
	return nil
}
func (m *mediaCache) download(ctx context.Context, id, path string) error {
	if _, e := strconv.ParseUint(id, 10, 64); e != nil {
		return errors.New("invalid original scene ID")
	}
	target := m.s.up.endpoint("/scene/" + id + "/stream")
	request, e := http.NewRequestWithContext(ctx, "GET", target.String(), nil)
	if e != nil {
		return e
	}
	if m.s.up.key != "" {
		request.Header.Set("ApiKey", m.s.up.key)
	}
	client := *m.s.up.client
	client.Timeout = 0
	r, e := client.Do(request)
	if e != nil {
		return errors.New("could not read original media through Stash")
	}
	defer r.Body.Close()
	if r.StatusCode != http.StatusOK {
		return fmt.Errorf("Stash original stream returned HTTP %d", r.StatusCode)
	}
	if r.ContentLength > m.s.cfg.MaxDownloadBytes {
		return errors.New("chapter exceeds max_download_bytes")
	}
	f, e := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0600)
	if e != nil {
		return e
	}
	n, e := io.Copy(f, io.LimitReader(r.Body, m.s.cfg.MaxDownloadBytes+1))
	ce := f.Close()
	if e != nil {
		return errors.New("reading original Stash stream failed")
	}
	if ce != nil {
		return ce
	}
	if n > m.s.cfg.MaxDownloadBytes {
		return errors.New("chapter exceeds max_download_bytes")
	}
	if r.ContentLength >= 0 && n != r.ContentLength {
		return errors.New("original stream ended prematurely")
	}
	return nil
}

type probeStream struct {
	CodecType  string `json:"codec_type"`
	CodecName  string `json:"codec_name"`
	Channels   int    `json:"channels"`
	SampleRate string `json:"sample_rate"`
}
type probeResult struct {
	Streams []probeStream `json:"streams"`
}

func (p probeResult) videoCodec() string {
	for _, s := range p.Streams {
		if s.CodecType == "video" {
			return s.CodecName
		}
	}
	return ""
}
func (p probeResult) signature() string {
	out := p.videoCodec()
	for _, s := range p.Streams {
		if s.CodecType == "audio" {
			return fmt.Sprintf("%s/%s/%s/%d", out, s.CodecName, s.SampleRate, s.Channels)
		}
	}
	return out + "/silent"
}
func (m *mediaCache) probe(ctx context.Context, path string) (probeResult, error) {
	var p probeResult
	cmd := exec.CommandContext(ctx, m.s.cfg.FFprobe, "-v", "error", "-protocol_whitelist", "file,pipe", "-show_streams", "-of", "json", path)
	b, e := cmd.Output()
	if e != nil || json.Unmarshal(b, &p) != nil {
		return p, errors.New("cannot inspect original media")
	}
	vc, ac := 0, 0
	for _, s := range p.Streams {
		if s.CodecType == "video" {
			vc++
			if s.CodecName != "h264" && s.CodecName != "hevc" {
				return p, errors.New("video codec is not H.264 or HEVC; no transcoding was performed")
			}
		}
		if s.CodecType == "audio" {
			ac++
			if s.CodecName != "aac" {
				return p, errors.New("audio codec is not AAC; no transcoding was performed")
			}
		}
	}
	if vc != 1 || ac > 1 {
		return p, errors.New("preview requires one video track and at most one audio track")
	}
	return p, nil
}

type chapterManifest struct {
	lines    []string
	files    []string
	target   int
	duration float64
}

func parseChapterManifest(text, prefix string) (chapterManifest, error) {
	var c chapterManifest
	scanner := bufio.NewScanner(strings.NewReader(text))
	for scanner.Scan() {
		l := strings.TrimSpace(scanner.Text())
		switch {
		case strings.HasPrefix(l, "#EXT-X-TARGETDURATION:"):
			c.target, _ = strconv.Atoi(strings.TrimPrefix(l, "#EXT-X-TARGETDURATION:"))
		case strings.HasPrefix(l, "#EXTINF:"):
			v := strings.TrimSuffix(strings.TrimPrefix(l, "#EXTINF:"), ",")
			n, e := strconv.ParseFloat(v, 64)
			if e != nil || n <= 0 || math.IsInf(n, 0) || math.IsNaN(n) {
				return c, errors.New("invalid packaged segment duration")
			}
			c.duration += n
			c.lines = append(c.lines, l)
		case l != "" && !strings.HasPrefix(l, "#"):
			if filepath.Base(l) != l || !strings.HasPrefix(l, "segment-") || !strings.HasSuffix(l, ".m4s") {
				return c, errors.New("invalid packaged segment path")
			}
			name := prefix + "/" + l
			c.files = append(c.files, name)
			c.lines = append(c.lines, name)
		}
	}
	if scanner.Err() != nil || len(c.files) == 0 {
		return c, errors.New("packaging produced no segments")
	}
	return c, nil
}
func combineManifests(chapters []chapterManifest) string {
	target := 1
	for _, c := range chapters {
		if c.target > target {
			target = c.target
		}
	}
	out := fmt.Sprintf("#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:%d\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n", target)
	for i, c := range chapters {
		if i > 0 {
			out += "#EXT-X-DISCONTINUITY\n"
		}
		out += fmt.Sprintf("#EXT-X-MAP:URI=\"%d/init.mp4\"\n", i)
		out += strings.Join(c.lines, "\n") + "\n"
	}
	return out + "#EXT-X-ENDLIST\n"
}

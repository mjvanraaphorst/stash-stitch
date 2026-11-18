package stitch

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/vektah/gqlparser/v2/ast"
)

const testKey = "test-service-key-32-characters-long"

// A tiny upstream fixture resolver: unlike project (which trims a real GraphQL
// response), this reads schema field names and produces response aliases.
func rawProject(g *gqlContext, o object, sel ast.SelectionSet) object {
	out := object{}
	for _, s := range sel {
		switch f := s.(type) {
		case *ast.InlineFragment:
			if g.enabled(f.Directives) {
				for k, v := range rawProject(g, o, f.SelectionSet) {
					out[k] = v
				}
			}
		case *ast.Field:
			if !g.enabled(f.Directives) {
				continue
			}
			v := o[f.Name]
			switch x := v.(type) {
			case object:
				v = rawProject(g, x, f.SelectionSet)
			case []any:
				if len(f.SelectionSet) > 0 {
					a := []any{}
					for _, x := range x {
						a = append(a, rawProject(g, obj(x), f.SelectionSet))
					}
					v = a
				}
			}
			out[key(f)] = v
		}
	}
	return out
}

func fixtures() ([]any, []any) {
	performer := func(id, name string) object { return object{"id": id, "name": name} }
	scene := func(id, title string, duration float64, p object) object {
		return object{"id": id, "title": title, "details": "First scene description", "date": "2021-02-05", "created_at": "2025-01-01T00:00:00Z", "updated_at": "2025-01-01T00:00:00Z", "studio": object{"id": "1", "name": "Synthetic Studio"}, "performers": []any{p}, "tags": []any{object{"id": "3", "name": "Example"}}, "files": []any{object{"id": id, "duration": duration, "size": "12000", "format": "mp4", "video_codec": "h264", "audio_codec": "aac", "width": 640.0, "height": 360.0, "frame_rate": 30.0}}, "paths": object{"screenshot": "http://upstream.invalid/scene/" + id + "/screenshot", "stream": "http://upstream.invalid/scene/" + id + "/stream"}, "groups": []any{object{"group": object{"id": "1"}, "scene_index": numString(id)}}}
	}
	a, b, c := scene("1", "The opening", 8, performer("10", "First performer")), scene("2", "Second chapter", 8, performer("20", "Second performer")), scene("3", "Standalone", 8, performer("20", "Second performer"))
	c["groups"] = []any{}
	return []any{a, b, c}, []any{object{"id": "1", "name": "A story in two chapters", "synopsis": "Group description", "scenes": []any{b, a}}}
}
func numString(s string) float64 {
	if s == "1" {
		return 1
	}
	return 2
}

type testRig struct {
	s             *Server
	server, up    *httptest.Server
	reads, writes atomic.Int64
	requests      []string
}

func newRig(t *testing.T, media string) *testRig {
	t.Helper()
	rig := &testRig{}
	scenes, groups := fixtures()
	rig.up = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("ApiKey") != "upstream-secret" {
			t.Errorf("upstream did not receive private key")
			http.Error(w, "unauthorized", 401)
			return
		}
		if r.URL.Path == "/graphql" {
			var req gqlRequest
			_ = json.NewDecoder(r.Body).Decode(&req)
			g, e := parseRequest(req)
			if e != nil {
				t.Error(e)
				return
			}
			if g.op.Operation == ast.Mutation {
				rig.writes.Add(1)
			}
			sel, e := g.expand(g.op.SelectionSet, 0)
			if e != nil {
				t.Fatal(e)
			}
			data := object{}
			for _, f := range g.rootFields(sel) {
				switch f.Name {
				case "version":
					data[key(f)] = object{"version": "v0.32.0"}
				case "findGroups":
					data[key(f)] = object{"groups": groups}
				case "findScenes":
					rows := []any{}
					ids := list(g.arg(f, "ids"))
					filter := obj(g.arg(f, "filter"))
					sf := obj(g.arg(f, "scene_filter"))
					for _, s := range scenes {
						o := obj(s)
						match := true
						if ids != nil {
							match = false
							for _, id := range ids {
								if id == o["id"] {
									match = true
								}
							}
						}
						if p := obj(sf["performers"]); p != nil {
							wanted := list(p["value"])
							match = match && len(wanted) > 0 && str(obj(list(o["performers"])[0])["id"]) == fmtString(wanted[0])
						}
						if q := str(filter["q"]); q != "" {
							match = match && strings.Contains(strings.ToLower(str(o["title"])), strings.ToLower(q))
						}
						if match {
							rows = append(rows, o)
						}
					}
					result := object{}
					for _, rf := range fields(f.SelectionSet) {
						if rf.Name == "count" {
							result[key(rf)] = len(rows)
						}
						if rf.Name == "scenes" {
							a := []any{}
							for _, row := range rows {
								a = append(a, rawProject(g, obj(row), rf.SelectionSet))
							}
							result[key(rf)] = a
						}
					}
					data[key(f)] = result
				case "findScene":
					for _, s := range scenes {
						if str(obj(s)["id"]) == str(g.arg(f, "id")) {
							data[key(f)] = rawProject(g, obj(s), f.SelectionSet)
						}
					}
				default:
					data[key(f)] = true
				}
			}
			writeJSON(w, object{"data": data})
			return
		}
		if strings.HasPrefix(r.URL.Path, "/scene/") && strings.HasSuffix(r.URL.Path, "/stream") {
			rig.reads.Add(1)
			if media == "" {
				http.Error(w, "no fixture", 404)
				return
			}
			http.ServeFile(w, r, media)
			return
		}
		if r.URL.Path == "/" {
			w.Header().Set("Content-Type", "text/html")
			_, _ = io.WriteString(w, "<html><head></head><body>Stash</body></html>")
			return
		}
		w.Header().Set("Content-Type", "image/png")
		_, _ = io.WriteString(w, "asset")
	}))
	cfg := Config{Listen: "127.0.0.1:0", StashURL: rig.up.URL, StashAPIKey: "upstream-secret", PublicURL: "http://127.0.0.1", ServiceKey: testKey, CacheDir: t.TempDir(), MaxCacheBytes: 128 << 20, MaxDownloadBytes: 16 << 20, MaxScenes: 100, PrepareTimeoutSeconds: 60, MediaTokenHours: 24, FFmpeg: os.Getenv("STITCH_TEST_FFMPEG"), FFprobe: os.Getenv("STITCH_TEST_FFPROBE")}
	var e error
	rig.s, e = New(cfg)
	if e != nil {
		t.Fatal(e)
	}
	rig.server = httptest.NewServer(rig.s)
	rig.s.cfg.PublicURL = rig.server.URL
	t.Cleanup(func() { rig.s.Close(); rig.server.Close(); rig.up.Close() })
	return rig
}
func fmtString(v any) string { b, _ := json.Marshal(v); return strings.Trim(string(b), `"`) }
func (rig *testRig) query(t *testing.T, q string, vars object) object {
	t.Helper()
	b, _ := json.Marshal(gqlRequest{Query: q, Variables: vars})
	req, _ := http.NewRequest("POST", rig.server.URL+"/graphql", bytes.NewReader(b))
	req.Header.Set("ApiKey", testKey)
	r, e := http.DefaultClient.Do(req)
	if e != nil {
		t.Fatal(e)
	}
	defer r.Body.Close()
	var out object
	if e = json.NewDecoder(r.Body).Decode(&out); e != nil {
		t.Fatal(e)
	}
	return out
}
func dataOK(t *testing.T, out object) object {
	t.Helper()
	if out["errors"] != nil {
		t.Fatalf("GraphQL errors: %v", out["errors"])
	}
	return obj(out["data"])
}

const sceneSelection = `id title details studio{id name} performers{id name} files{id duration format} paths{screenshot stream} resume_time play_count`

func TestLibraryAndPerformerPagination(t *testing.T) {
	r := newRig(t, "")
	out := dataOK(t, r.query(t, `query($sf:SceneFilterType,$filter:FindFilterType){library:findScenes(scene_filter:$sf,filter:$filter){total:count items:scenes{...Card}}} fragment Card on Scene{`+sceneSelection+`}`, object{"sf": object{"performers": object{"value": []any{"20"}, "modifier": "INCLUDES"}}, "filter": object{"page": 1, "per_page": 1, "sort": "title", "direction": "ASC"}}))
	result := obj(out["library"])
	if num(result["total"]) != 2 {
		t.Fatalf("performer should see group and standalone: %v", result)
	}
	rows := list(result["items"])
	group := obj(rows[0])
	if str(group["id"]) != "stitch-1" || str(group["title"]) != "A story in two chapters" {
		t.Fatalf("wrong virtual card: %v", group)
	}
	if len(list(group["performers"])) != 2 {
		t.Fatal("performers were not combined across chapters")
	}
	if num(obj(list(group["files"])[0])["duration"]) != 16 {
		t.Fatal("combined duration missing")
	}
	if str(obj(group["studio"])["name"]) != "Synthetic Studio" || !strings.Contains(str(obj(group["paths"])["screenshot"]), "/scene/1/") {
		t.Fatal("first-scene metadata not retained")
	}
	if group["_stitchInternalId"] != nil {
		t.Fatal("private bookkeeping leaked")
	}
	out = dataOK(t, r.query(t, `{findScenes(filter:{page:2,per_page:1,sort:"title",direction:ASC}){count scenes{id title}}}`, nil))
	rows = list(obj(out["findScenes"])["scenes"])
	if len(rows) != 1 || str(obj(rows[0])["id"]) != "3" {
		t.Fatal("pagination was applied before collapsing")
	}
}
func TestSearchGroupAndOriginalsInsideGroups(t *testing.T) {
	r := newRig(t, "")
	d := dataOK(t, r.query(t, `{findScenes(filter:{q:"story"}){count scenes{id title}}}`, nil))
	if num(obj(d["findScenes"])["count"]) != 1 {
		t.Fatal("group title not searchable")
	}
	d = dataOK(t, r.query(t, `{findScenes(scene_filter:{groups:{value:["1"],modifier:INCLUDES}}){count scenes{id title}}}`, nil))
	for _, v := range list(obj(d["findScenes"])["scenes"]) {
		if strings.HasPrefix(str(obj(v)["id"]), "stitch-") {
			t.Fatal("group menu should show original chapters")
		}
	}
}
func TestAliasesVariablesDefaultsAndDirectives(t *testing.T) {
	r := newRig(t, "")
	d := dataOK(t, r.query(t, `query($id:ID!="stitch-1",$show:Boolean!=true){a:findScene(id:$id){identifier:id name:title ... on Scene @include(if:$show){text:details tracks:files{length:duration} people:performers{identifier:id}}} hidden:findScene(id:"2") @skip(if:$show){id}}`, nil))
	a := obj(d["a"])
	if str(a["identifier"]) != "stitch-1" || str(a["text"]) != "Group description" || num(obj(list(a["tracks"])[0])["length"]) != 16 {
		t.Fatalf("aliases not decorated: %v", d)
	}
	if _, ok := d["hidden"]; ok {
		t.Fatal("skip directive ignored")
	}
	if len(list(a["people"])) != 2 {
		t.Fatal("aliased performers not unioned")
	}
}
func TestAuthenticationAndSignedMedia(t *testing.T) {
	r := newRig(t, "")
	resp, e := http.Get(r.server.URL + "/graphql")
	if e != nil {
		t.Fatal(e)
	}
	resp.Body.Close()
	if resp.StatusCode != 401 {
		t.Fatal("unauthenticated library exposed")
	}
	cat, e := r.s.catalog(context.Background())
	if e != nil {
		t.Fatal(e)
	}
	g := cat.Groups["1"]
	url := r.s.playbackURL(g)
	if strings.Contains(url, testKey) || strings.Contains(url, "upstream-secret") {
		t.Fatal("media URL leaks API key")
	}
	req, _ := http.NewRequest("GET", url, nil)
	if !r.s.validSignature(req, g.ID+"/"+g.Revision) {
		t.Fatal("valid media signature rejected")
	}
	if r.s.validSignature(req, "2/"+g.Revision) {
		t.Fatal("signature is not group scoped")
	}
	expired := r.s.signedURL("/stitch/hls/1/x/stream.m3u8", "1/x", time.Now().Add(-time.Hour).Unix())
	req, _ = http.NewRequest("GET", expired, nil)
	if r.s.validSignature(req, "1/x") {
		t.Fatal("expired media allowed")
	}
}
func TestVirtualActivityIsLocalAndDestructionBlocked(t *testing.T) {
	r := newRig(t, "")
	dataOK(t, r.query(t, `mutation{sceneSaveActivity(id:"stitch-1",resume_time:11,playDuration:2)}`, nil))
	d := dataOK(t, r.query(t, `{findScene(id:"stitch-1"){id resume_time play_duration}}`, nil))
	if num(obj(d["findScene"])["resume_time"]) != 11 {
		t.Fatal("virtual resume not retained")
	}
	out := r.query(t, `mutation{sceneDestroy(input:{id:"stitch-1",delete_file:true})}`, nil)
	if out["errors"] == nil {
		t.Fatal("virtual deletion not blocked")
	}
	if r.writes.Load() != 0 {
		t.Fatal("virtual mutations reached real Stash")
	}
	a := activityStore{}
	if e := a.load(statePath(r.s.cfg.CacheDir)); e != nil || a.get("1").Resume != 11 {
		t.Fatal("resume did not survive reload")
	}
}
func TestExplicitIDsAndCountOnly(t *testing.T) {
	r := newRig(t, "")
	d := dataOK(t, r.query(t, `{findScenes(ids:["stitch-1","3"]){count scenes{id}}}`, nil))
	if num(obj(d["findScenes"])["count"]) != 2 {
		t.Fatal("mixed virtual/real IDs failed")
	}
	d = dataOK(t, r.query(t, `{findScenes(ids:["2"]){count scenes{id}}}`, nil))
	if str(obj(list(obj(d["findScenes"])["scenes"])[0])["id"]) != "2" {
		t.Fatal("explicit chapter ID should remain accessible")
	}
	d = dataOK(t, r.query(t, `{findScenes{count duration filesize}}`, nil))
	if num(obj(d["findScenes"])["count"]) != 2 || num(obj(d["findScenes"])["duration"]) != 24 {
		t.Fatalf("count-only aggregates wrong: %v", d)
	}
}
func TestFragmentCycleRejected(t *testing.T) {
	r := newRig(t, "")
	out := r.query(t, `{findScenes{scenes{...Loop}}} fragment Loop on Scene{...Loop}`, nil)
	if out["errors"] == nil {
		t.Fatal("fragment cycle not rejected")
	}
}

func TestIncompatibleMediaAndCatalogOwnership(t *testing.T) {
	rows, groups := fixtures()
	groups = append(groups, object{"id": "2", "name": "Overlap", "scenes": []any{rows[1], rows[2]}})
	c := buildCatalog(groups)
	if len(c.Groups) != 1 || c.Members["3"] != nil {
		t.Fatal("overlapping group stole an original scene")
	}
	obj(list(obj(groups[0])["scenes"])[0])["files"] = []any{}
	if len(buildCatalog(groups[:1]).Groups) != 0 {
		t.Fatal("missing media must not be silently skipped")
	}
	a := probeResult{Streams: []probeStream{{CodecType: "video", CodecName: "h264"}, {CodecType: "audio", CodecName: "aac", Channels: 2, SampleRate: "48000"}}}
	b := a
	b.Streams = append([]probeStream{}, a.Streams...)
	b.Streams[1].SampleRate = "44100"
	if a.signature() == b.signature() {
		t.Fatal("different audio layouts accepted")
	}
}

func TestSecretAliasesAndConfigValidation(t *testing.T) {
	r := newRig(t, "")
	g, e := parseRequest(gqlRequest{Query: `{findConfiguration{general{privateKey:apiKey secret:password}}}`})
	if e != nil {
		t.Fatal(e)
	}
	sel, e := g.expand(g.op.SelectionSet, 0)
	if e != nil {
		t.Fatal(e)
	}
	data := object{"general": object{"privateKey": "upstream-secret", "secret": "private"}}
	r.s.protectSecrets(data, fields(sel)[0].SelectionSet)
	if str(obj(data["general"])["privateKey"]) != testKey || obj(data["general"])["secret"] != "" {
		t.Fatal("aliased secrets exposed")
	}
	cfg := r.s.cfg
	cfg.PublicURL = "http://example.com/path"
	if cfg.Validate() == nil {
		t.Fatal("unsupported public subpath accepted")
	}
	cfg = r.s.cfg
	cfg.ServiceKey = "CHANGE_THIS_KEY_BEFORE_STARTING"
	if cfg.Validate() == nil {
		t.Fatal("placeholder service key accepted")
	}
}
func TestHTMLBootstrapAndURLCredentials(t *testing.T) {
	r := newRig(t, "")
	req, _ := http.NewRequest("GET", r.server.URL+"/", nil)
	req.Header.Set("ApiKey", testKey)
	resp, e := http.DefaultClient.Do(req)
	if e != nil {
		t.Fatal(e)
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if !strings.Contains(string(b), `src="/stitch/bootstrap.js"`) {
		t.Fatal("proxy not marked for plugin")
	}
	url := r.s.rewriteURL(r.up.URL + "/scene/1/screenshot?apikey=upstream-secret&x=1")
	if strings.Contains(url, "upstream-secret") || !strings.HasPrefix(url, r.server.URL) {
		t.Fatal("upstream credentials leaked")
	}
}
func TestStreamCopyHLS(t *testing.T) {
	ffmpeg, ffprobe := os.Getenv("STITCH_TEST_FFMPEG"), os.Getenv("STITCH_TEST_FFPROBE")
	if ffmpeg == "" || ffprobe == "" {
		t.Skip("set STITCH_TEST_FFMPEG and STITCH_TEST_FFPROBE for actual media verification")
	}
	path := filepath.Join(t.TempDir(), "clip.mp4")
	cmd := exec.Command(ffmpeg, "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=blue:s=320x180:r=25", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "2", "-c:v", "libx264", "-threads", "1", "-g", "25", "-pix_fmt", "yuv420p", "-c:a", "aac", path)
	if b, e := cmd.CombinedOutput(); e != nil {
		t.Fatalf("fixture: %v %s", e, b)
	}
	r := newRig(t, path)
	cat, e := r.s.catalog(context.Background())
	if e != nil {
		t.Fatal(e)
	}
	g := cat.Groups["1"]
	url := r.s.playbackURL(g)
	resp, e := http.Get(url)
	if e != nil {
		t.Fatal(e)
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("HLS preparation failed: %d %s", resp.StatusCode, b)
	}
	if strings.Count(string(b), "#EXT-X-DISCONTINUITY") != 1 || !strings.Contains(string(b), "#EXT-X-ENDLIST") {
		t.Fatalf("not one complete group presentation: %s", b)
	}
	if r.reads.Load() != 2 {
		t.Fatalf("expected originals fetched through Stash, got %d", r.reads.Load())
	}
	resp, e = http.Get(url)
	if e != nil {
		t.Fatal(e)
	}
	resp.Body.Close()
	if r.reads.Load() != 2 {
		t.Fatal("prepared media downloaded again")
	}
	output, e := exec.Command(ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "json", url).CombinedOutput()
	if e != nil {
		t.Fatalf("receiver cannot read signed HLS segments: %s %v", output, e)
	}
	var probe object
	_ = json.Unmarshal(output, &probe)
	duration := str(obj(probe["format"])["duration"])
	if !strings.HasPrefix(duration, "4.") {
		t.Fatalf("combined HLS duration should be about four seconds: %s", output)
	}
	// Compare encoded packet hashes from the first output chapter to the original.
	hashes := func(p string) string {
		b, e := exec.Command(ffprobe, "-v", "error", "-select_streams", "v:0", "-show_packets", "-show_data_hash", "sha256", "-show_entries", "packet=data_hash", "-of", "csv=p=0", p).CombinedOutput()
		if e != nil {
			t.Fatalf("packet hashes: %v %s", e, b)
		}
		return string(b)
	}
	entry := r.s.media.start(g)
	init, _ := os.ReadFile(filepath.Join(entry.dir, "0", "init.mp4"))
	seg, _ := os.ReadFile(filepath.Join(entry.dir, "0", "segment-000000.m4s"))
	packaged := filepath.Join(t.TempDir(), "copy.mp4")
	_ = os.WriteFile(packaged, append(init, seg...), 0600)
	if hashes(path) != hashes(packaged) {
		t.Fatal("encoded video packets changed during packaging")
	}
}

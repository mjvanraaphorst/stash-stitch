package stitch

import (
	"encoding/json"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/vektah/gqlparser/v2/ast"
)

type Activity struct {
	Resume     float64 `json:"resume"`
	Duration   float64 `json:"duration"`
	Plays      int     `json:"plays"`
	LastPlayed string  `json:"last_played,omitempty"`
}
type activityStore struct {
	mu      sync.Mutex
	path    string
	entries map[string]Activity
}

func (a *activityStore) load(path string) error {
	a.path = path
	a.entries = map[string]Activity{}
	b, e := os.ReadFile(path)
	if os.IsNotExist(e) {
		return nil
	}
	if e != nil {
		return e
	}
	return json.Unmarshal(b, &a.entries)
}
func (a *activityStore) get(id string) Activity {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.entries[id]
}
func (s *Server) virtualActivity(w http.ResponseWriter, g *gqlContext, f *ast.Field) bool {
	if f.Name != "sceneSaveActivity" && f.Name != "sceneAddPlay" && f.Name != "sceneIncrementPlayCount" {
		return false
	}
	id := strings.TrimPrefix(str(g.arg(f, "id")), "stitch-")
	if id == "" {
		return false
	}
	s.activity.mu.Lock()
	defer s.activity.mu.Unlock()
	state := s.activity.entries[id]
	if f.Name == "sceneSaveActivity" {
		if v := g.arg(f, "resume_time"); v != nil {
			state.Resume = math.Max(0, num(v))
		}
		state.Duration += math.Max(0, num(g.arg(f, "playDuration")))
	} else {
		state.Plays++
		state.LastPlayed = time.Now().UTC().Format(time.RFC3339)
	}
	s.activity.entries[id] = state
	b, e := json.Marshal(s.activity.entries)
	if e == nil {
		e = os.WriteFile(s.activity.path+".tmp", b, 0600)
	}
	if e == nil {
		e = os.Rename(s.activity.path+".tmp", s.activity.path)
	}
	if e != nil {
		gqlError(w, e)
		return true
	}
	var value any = true
	if f.Name == "sceneIncrementPlayCount" {
		value = state.Plays
	}
	if f.Name == "sceneAddPlay" {
		value = object{"count": state.Plays, "history": []string{state.LastPlayed}}
		value = project(g, obj(value), f.SelectionSet)
	}
	writeJSON(w, object{"data": object{key(f): value}})
	return true
}
func statePath(dir string) string { return filepath.Join(dir, "activity.json") }

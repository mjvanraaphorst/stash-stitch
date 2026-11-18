package stitch

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"sync"
	"time"
)

type Chapter struct {
	ID       string
	Index    int
	Duration float64
	Size     int64
	Stamp    string
}
type Group struct {
	ID, Name, Description, Revision string
	Chapters                        []Chapter
	Duration                        float64
	Size                            int64
}

func (g *Group) VirtualID() string { return "stitch-" + g.ID }

type Catalog struct {
	Groups  map[string]*Group
	Members map[string]*Group
}
type catalogCache struct {
	mu      sync.Mutex
	value   *Catalog
	expires time.Time
}

const catalogQuery = `query {findGroups(filter:{per_page:-1},group_filter:{scene_count:{value:1,modifier:GREATER_THAN}}){groups{id name synopsis updated_at scenes{id updated_at groups{group{id} scene_index} files{id duration size format video_codec audio_codec width height frame_rate mod_time}}}}}`

func (s *Server) catalog(ctx context.Context) (*Catalog, error) {
	s.catalogCache.mu.Lock()
	defer s.catalogCache.mu.Unlock()
	if s.catalogCache.value != nil && time.Now().Before(s.catalogCache.expires) {
		return s.catalogCache.value, nil
	}
	d, e := s.up.data(ctx, catalogQuery)
	if e != nil {
		return nil, e
	}
	groups := list(obj(d["findGroups"])["groups"])
	if len(groups) > s.cfg.MaxScenes {
		return nil, fmt.Errorf("group catalog exceeds max_scenes")
	}
	c := buildCatalog(groups)
	s.catalogCache.value = c
	s.catalogCache.expires = time.Now().Add(15 * time.Second)
	return c, nil
}
func buildCatalog(rows []any) *Catalog {
	c := &Catalog{Groups: map[string]*Group{}, Members: map[string]*Group{}}
	sort.Slice(rows, func(i, j int) bool {
		a, _ := strconv.Atoi(str(obj(rows[i])["id"]))
		b, _ := strconv.Atoi(str(obj(rows[j])["id"]))
		return a < b
	})
	for _, row := range rows {
		r := obj(row)
		g := &Group{ID: str(r["id"]), Name: str(r["name"]), Description: str(r["synopsis"])}
		valid := true
		for _, v := range list(r["scenes"]) {
			scene := obj(v)
			files := list(scene["files"])
			if len(files) == 0 || num(obj(files[0])["duration"]) <= 0 {
				valid = false
				break
			}
			id := str(scene["id"])
			if c.Members[id] != nil {
				valid = false
				break
			}
			index := int(^uint(0) >> 1)
			for _, rel := range list(scene["groups"]) {
				o := obj(rel)
				if str(obj(o["group"])["id"]) == g.ID && o["scene_index"] != nil {
					index = int(num(o["scene_index"]))
				}
			}
			b, _ := json.Marshal(files[0])
			f := obj(files[0])
			sz, _ := strconv.ParseInt(fmt.Sprint(f["size"]), 10, 64)
			g.Chapters = append(g.Chapters, Chapter{id, index, num(f["duration"]), sz, str(scene["updated_at"]) + string(b)})
			g.Duration += num(f["duration"])
			g.Size += sz
		}
		if !valid || len(g.Chapters) < 2 {
			continue
		}
		sort.Slice(g.Chapters, func(i, j int) bool {
			a, b := g.Chapters[i], g.Chapters[j]
			if a.Index != b.Index {
				return a.Index < b.Index
			}
			ai, _ := strconv.Atoi(a.ID)
			bi, _ := strconv.Atoi(b.ID)
			return ai < bi
		})
		b, _ := json.Marshal(g)
		sum := sha256.Sum256(b)
		g.Revision = hex.EncodeToString(sum[:12])
		c.Groups[g.ID] = g
		for _, ch := range g.Chapters {
			c.Members[ch.ID] = g
		}
	}
	return c
}

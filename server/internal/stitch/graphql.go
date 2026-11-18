package stitch

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"

	"github.com/vektah/gqlparser/v2/ast"
	"github.com/vektah/gqlparser/v2/formatter"
	"github.com/vektah/gqlparser/v2/parser"
)

type gqlRequest struct {
	Query     string `json:"query"`
	Variables object `json:"variables"`
	Operation string `json:"operationName"`
}
type gqlContext struct {
	doc  *ast.QueryDocument
	op   *ast.OperationDefinition
	vars object
}

func parseRequest(r gqlRequest) (*gqlContext, error) {
	d, e := parser.ParseQuery(&ast.Source{Input: r.Query})
	if e != nil {
		return nil, errors.New("invalid GraphQL document")
	}
	var op *ast.OperationDefinition
	if r.Operation != "" {
		op = d.Operations.ForName(r.Operation)
	} else if len(d.Operations) == 1 {
		op = d.Operations[0]
	}
	if op == nil {
		return nil, errors.New("select a single GraphQL operation")
	}
	v := r.Variables
	if v == nil {
		v = object{}
	}
	for _, def := range op.VariableDefinitions {
		if _, ok := v[def.Variable]; !ok && def.DefaultValue != nil {
			v[def.Variable], e = def.DefaultValue.Value(v)
			if e != nil {
				return nil, e
			}
		}
	}
	return &gqlContext{d, op, v}, nil
}
func (g *gqlContext) expand(sel ast.SelectionSet, depth int) (ast.SelectionSet, error) {
	if depth > 32 {
		return nil, errors.New("GraphQL fragment nesting exceeds 32")
	}
	var out ast.SelectionSet
	for _, s := range sel {
		switch f := s.(type) {
		case *ast.Field:
			c := *f
			var e error
			c.SelectionSet, e = g.expand(c.SelectionSet, depth+1)
			if e != nil {
				return nil, e
			}
			out = append(out, &c)
		case *ast.InlineFragment:
			c := *f
			var e error
			c.SelectionSet, e = g.expand(c.SelectionSet, depth+1)
			if e != nil {
				return nil, e
			}
			out = append(out, &c)
		case *ast.FragmentSpread:
			fr := g.doc.Fragments.ForName(f.Name)
			if fr == nil {
				return nil, errors.New("unknown fragment")
			}
			sub, e := g.expand(fr.SelectionSet, depth+1)
			if e != nil {
				return nil, e
			}
			out = append(out, &ast.InlineFragment{TypeCondition: fr.TypeCondition, Directives: f.Directives, SelectionSet: sub})
		}
	}
	return out, nil
}
func collectVars(sel ast.SelectionSet, names map[string]bool) {
	var val func(*ast.Value)
	val = func(v *ast.Value) {
		if v == nil {
			return
		}
		if v.Kind == ast.Variable {
			names[v.Raw] = true
		}
		for _, c := range v.Children {
			val(c.Value)
		}
	}
	dirs := func(ds ast.DirectiveList) {
		for _, d := range ds {
			for _, a := range d.Arguments {
				val(a.Value)
			}
		}
	}
	for _, s := range sel {
		switch f := s.(type) {
		case *ast.Field:
			for _, a := range f.Arguments {
				val(a.Value)
			}
			dirs(f.Directives)
			collectVars(f.SelectionSet, names)
		case *ast.InlineFragment:
			dirs(f.Directives)
			collectVars(f.SelectionSet, names)
		}
	}
}
func (g *gqlContext) query(field *ast.Field) string {
	op := *g.op
	op.Name = ""
	op.SelectionSet = ast.SelectionSet{field}
	op.VariableDefinitions = nil
	op.Directives = nil
	names := map[string]bool{}
	collectVars(op.SelectionSet, names)
	for _, v := range g.op.VariableDefinitions {
		if names[v.Variable] {
			op.VariableDefinitions = append(op.VariableDefinitions, v)
		}
	}
	var b bytes.Buffer
	formatter.NewFormatter(&b).FormatQueryDocument(&ast.QueryDocument{Operations: ast.OperationList{&op}})
	return b.String()
}
func fields(sel ast.SelectionSet) []*ast.Field {
	var out []*ast.Field
	for _, s := range sel {
		switch f := s.(type) {
		case *ast.Field:
			out = append(out, f)
		case *ast.InlineFragment:
			out = append(out, fields(f.SelectionSet)...)
		}
	}
	return out
}
func key(f *ast.Field) string {
	if f.Alias != "" {
		return f.Alias
	}
	return f.Name
}
func (g *gqlContext) arg(f *ast.Field, name string) any {
	a := f.Arguments.ForName(name)
	if a == nil {
		return nil
	}
	v, _ := a.Value.Value(g.vars)
	return v
}
func lit(v any, name string) *ast.Value {
	switch x := v.(type) {
	case nil:
		return &ast.Value{Kind: ast.NullValue, Raw: "null"}
	case string:
		k := ast.StringValue
		if name == "direction" {
			k = ast.EnumValue
		}
		return &ast.Value{Kind: k, Raw: x}
	case bool:
		return &ast.Value{Kind: ast.BooleanValue, Raw: strconv.FormatBool(x)}
	case float64:
		return &ast.Value{Kind: ast.FloatValue, Raw: strconv.FormatFloat(x, 'f', -1, 64)}
	case int:
		return &ast.Value{Kind: ast.IntValue, Raw: strconv.Itoa(x)}
	case []any:
		r := &ast.Value{Kind: ast.ListValue}
		for _, a := range x {
			r.Children = append(r.Children, &ast.ChildValue{Value: lit(a, "")})
		}
		return r
	case object:
		r := &ast.Value{Kind: ast.ObjectValue}
		ks := make([]string, 0, len(x))
		for k := range x {
			ks = append(ks, k)
		}
		sort.Strings(ks)
		for _, k := range ks {
			r.Children = append(r.Children, &ast.ChildValue{Name: k, Value: lit(x[k], k)})
		}
		return r
	}
	panic(fmt.Sprintf("unsupported literal %T", v))
}
func setArg(f *ast.Field, name string, value *ast.Value) {
	args := ast.ArgumentList{}
	for _, a := range f.Arguments {
		if a.Name != name {
			args = append(args, a)
		}
	}
	if value != nil {
		args = append(args, &ast.Argument{Name: name, Value: value})
	}
	f.Arguments = args
}
func (g *gqlContext) enabled(ds ast.DirectiveList) bool {
	for _, d := range ds {
		a := d.Arguments.ForName("if")
		if a == nil {
			continue
		}
		v, _ := a.Value.Value(g.vars)
		if d.Name == "skip" && v == true || d.Name == "include" && v == false {
			return false
		}
	}
	return true
}
func (g *gqlContext) rootFields(sel ast.SelectionSet) []*ast.Field {
	var out []*ast.Field
	for _, s := range sel {
		switch f := s.(type) {
		case *ast.Field:
			if g.enabled(f.Directives) {
				out = append(out, f)
			}
		case *ast.InlineFragment:
			if g.enabled(f.Directives) {
				out = append(out, g.rootFields(f.SelectionSet)...)
			}
		}
	}
	return out
}
func hasGroupFilter(v any) bool {
	switch x := v.(type) {
	case object:
		for k, v := range x {
			if (k == "groups" || k == "movies") && v != nil {
				return true
			}
			if hasGroupFilter(v) {
				return true
			}
		}
	case []any:
		for _, v := range x {
			if hasGroupFilter(v) {
				return true
			}
		}
	}
	return false
}
func containsVirtual(v any) bool {
	switch x := v.(type) {
	case string:
		return strings.HasPrefix(x, "stitch-")
	case object:
		for _, v := range x {
			if containsVirtual(v) {
				return true
			}
		}
	case []any:
		for _, v := range x {
			if containsVirtual(v) {
				return true
			}
		}
	}
	return false
}

func (s *Server) graphql(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" && r.Method != "GET" {
		http.Error(w, "method not allowed", 405)
		return
	}
	var req gqlRequest
	if r.Method == "GET" {
		req.Query = r.URL.Query().Get("query")
		req.Operation = r.URL.Query().Get("operationName")
		if v := r.URL.Query().Get("variables"); v != "" {
			if json.Unmarshal([]byte(v), &req.Variables) != nil {
				http.Error(w, "invalid variables", 400)
				return
			}
		}
	} else if json.NewDecoder(http.MaxBytesReader(w, r.Body, 2<<20)).Decode(&req) != nil {
		http.Error(w, "invalid GraphQL request", 400)
		return
	}
	g, e := parseRequest(req)
	if e != nil {
		gqlError(w, e)
		return
	}
	sel, e := g.expand(g.op.SelectionSet, 0)
	if e != nil {
		gqlError(w, e)
		return
	}
	roots := g.rootFields(sel)
	if g.op.Operation == ast.Mutation {
		for _, f := range roots {
			if f.Name == "generateAPIKey" {
				gqlError(w, errors.New("change Stash authentication at the original Stash address, then update companion configuration"))
				return
			}
			for _, a := range f.Arguments {
				v, _ := a.Value.Value(g.vars)
				if containsVirtual(v) {
					if len(roots) == 1 && s.virtualActivity(w, g, f) {
						return
					}
					gqlError(w, errors.New("virtual grouped scenes are read-only; edit original scenes or the group in Stash"))
					return
				}
			}
		}
		out, e := s.up.graphql(r.Context(), req.Query, req.Variables, req.Operation)
		if e != nil {
			gqlError(w, e)
			return
		}
		for _, f := range roots {
			s.protectSecrets(obj(out["data"])[key(f)], f.SelectionSet)
		}
		s.rewriteURLs(out)
		writeJSON(w, out)
		return
	}
	if g.op.Operation != ast.Query {
		gqlError(w, errors.New("subscriptions are not supported by the companion"))
		return
	}
	data := object{}
	errs := []any{}
	var cat *Catalog
	for _, f := range roots {
		var value any
		var e error
		switch f.Name {
		case "findScenes", "findScene", "sceneStreams", "allScenes":
			if cat == nil {
				cat, e = s.catalog(r.Context())
			}
			if e == nil {
				value, e = s.sceneRoot(r.Context(), g, f, cat)
			}
		default:
			var d object
			d, e = s.up.dataVars(r.Context(), g.query(f), g.vars)
			if e == nil {
				value = d[key(f)]
			}
		}
		if e != nil {
			errs = append(errs, object{"message": e.Error(), "path": []string{key(f)}})
			data[key(f)] = nil
		} else {
			s.protectSecrets(value, f.SelectionSet)
			data[key(f)] = value
		}
	}
	s.rewriteURLs(data)
	out := object{"data": data}
	if len(errs) > 0 {
		out["errors"] = errs
	}
	writeJSON(w, out)
}

// Stash's configuration query exposes its API key. A client connected to the
// companion must receive the companion key, never the private upstream key.
func (s *Server) protectSecrets(value any, sel ast.SelectionSet) {
	switch v := value.(type) {
	case []any:
		for _, item := range v {
			s.protectSecrets(item, sel)
		}
	case object:
		for _, f := range fields(sel) {
			k := key(f)
			if f.Name == "apiKey" {
				v[k] = s.cfg.ServiceKey
			} else if f.Name == "password" {
				v[k] = ""
			} else {
				s.protectSecrets(v[k], f.SelectionSet)
			}
		}
	}
}
func gqlError(w http.ResponseWriter, e error) {
	writeJSON(w, object{"errors": []object{{"message": e.Error()}}, "data": nil})
}
func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(v)
}

func (s *Server) sceneRoot(ctx context.Context, g *gqlContext, f *ast.Field, c *Catalog) (any, error) {
	id := str(g.arg(f, "id"))
	virtual := strings.HasPrefix(id, "stitch-")
	if f.Name == "findScene" || f.Name == "sceneStreams" {
		if !virtual {
			d, e := s.up.dataVars(ctx, g.query(f), g.vars)
			return d[key(f)], e
		}
		group := c.Groups[strings.TrimPrefix(id, "stitch-")]
		if group == nil {
			return nil, errors.New("group is missing or cannot be represented as a video")
		}
		if f.Name == "sceneStreams" {
			return s.streams(group, f.SelectionSet), nil
		}
		rows, e := s.chapterRows(ctx, g, group, f.SelectionSet)
		if e != nil {
			return nil, e
		}
		return s.virtualScene(g, group, rows, f.SelectionSet), nil
	}
	if f.Name == "allScenes" {
		copy := *f
		copy.Name = "findScenes"
		copy.SelectionSet = ast.SelectionSet{&ast.Field{Name: "scenes", SelectionSet: f.SelectionSet}}
		v, e := s.sceneList(ctx, g, &copy, c)
		return obj(v)["scenes"], e
	}
	return s.sceneList(ctx, g, f, c)
}
func (s *Server) chapterRows(ctx context.Context, g *gqlContext, group *Group, sel ast.SelectionSet) (map[string]object, error) {
	ids := []any{}
	for _, ch := range group.Chapters {
		ids = append(ids, ch.ID)
	}
	return s.fetchRows(ctx, g, ids, sel)
}
func (s *Server) fetchRows(ctx context.Context, g *gqlContext, ids []any, sel ast.SelectionSet) (map[string]object, error) {
	if len(ids) == 0 {
		return map[string]object{}, nil
	}
	sub := append(ast.SelectionSet{}, sel...)
	sub = append(sub, &ast.Field{Name: "id", Alias: "_stitchInternalId"})
	f := &ast.Field{Name: "findScenes", Arguments: ast.ArgumentList{&ast.Argument{Name: "ids", Value: lit(ids, "")}, &ast.Argument{Name: "filter", Value: lit(object{"per_page": -1}, "")}}, SelectionSet: ast.SelectionSet{&ast.Field{Name: "scenes", SelectionSet: sub}}}
	d, e := s.up.dataVars(ctx, g.query(f), g.vars)
	if e != nil {
		return nil, e
	}
	rows := map[string]object{}
	for _, v := range list(obj(d["findScenes"])["scenes"]) {
		o := obj(v)
		rows[str(o["_stitchInternalId"])] = o
	}
	if len(rows) != len(ids) {
		return nil, errors.New("some group chapters are unavailable")
	}
	return rows, nil
}
func (s *Server) sceneList(ctx context.Context, g *gqlContext, f *ast.Field, c *Catalog) (any, error) {
	// Explicit group filters are chapter-browsing views. Keep those results original.
	if hasGroupFilter(g.arg(f, "scene_filter")) {
		d, e := s.up.dataVars(ctx, g.query(f), g.vars)
		return d[key(f)], e
	}
	filter := clone(obj(g.arg(f, "filter")))
	if filter == nil {
		filter = object{}
	}
	page, per := int(num(filter["page"])), int(num(filter["per_page"]))
	if page < 1 {
		page = 1
	}
	if per == 0 {
		per = 25
	}
	if per < -1 || per > s.cfg.MaxScenes {
		return nil, errors.New("invalid per_page")
	}
	var scenesSel ast.SelectionSet
	for _, sf := range fields(f.SelectionSet) {
		if sf.Name == "scenes" {
			scenesSel = append(scenesSel, sf.SelectionSet...)
		}
	}
	// Even count-only requests need IDs so collapsing happens before pagination.
	internal := append(ast.SelectionSet{}, scenesSel...)
	internal = append(internal, &ast.Field{Name: "id", Alias: "_stitchInternalId"}, &ast.Field{Name: "files", Alias: "_stitchInternalFiles", SelectionSet: ast.SelectionSet{&ast.Field{Name: "duration"}, &ast.Field{Name: "size"}}})
	sortName := str(filter["sort"])
	sortField := map[string]string{"title": "title", "date": "date", "created_at": "created_at", "updated_at": "updated_at", "rating": "rating100", "rating100": "rating100", "play_count": "play_count"}[sortName]
	if sortField != "" {
		internal = append(internal, &ast.Field{Name: sortField, Alias: "_stitchInternalSort"})
	}
	request := *f
	request.Alias = ""
	request.SelectionSet = ast.SelectionSet{&ast.Field{Name: "scenes", SelectionSet: internal}, &ast.Field{Name: "count"}}
	all := clone(filter)
	all["page"] = 1
	all["per_page"] = -1
	setArg(&request, "filter", lit(all, ""))
	// Explicit lists can contain virtual IDs (e.g. watchlists). Expand them only for matching.
	var requested map[string]bool
	for _, argName := range []string{"ids", "scene_ids"} {
		if a := g.arg(f, argName); a != nil {
			requested = map[string]bool{}
			ids := []any{}
			for _, v := range list(a) {
				id := fmt.Sprint(v)
				requested[id] = true
				if group := c.Groups[strings.TrimPrefix(id, "stitch-")]; strings.HasPrefix(id, "stitch-") && group != nil {
					for _, ch := range group.Chapters {
						ids = append(ids, ch.ID)
					}
				} else {
					ids = append(ids, id)
				}
			}
			setArg(&request, argName, nil)
			setArg(&request, "ids", lit(ids, ""))
		}
	}
	d, e := s.up.dataVars(ctx, g.query(&request), g.vars)
	if e != nil {
		return nil, e
	}
	upResult := obj(d["findScenes"])
	rows := list(upResult["scenes"])
	if num(upResult["count"]) > float64(s.cfg.MaxScenes) || len(rows) > s.cfg.MaxScenes {
		return nil, errors.New("matching library exceeds max_scenes; narrow the filter or raise the limit")
	}
	// Add group-name search matches, but retain the client's performer/studio/tag filter.
	q := strings.ToLower(str(filter["q"]))
	if q != "" && requested == nil {
		ids := []any{}
		for _, group := range c.Groups {
			if strings.Contains(strings.ToLower(group.Name+" "+group.Description), q) {
				for _, ch := range group.Chapters {
					ids = append(ids, ch.ID)
				}
			}
		}
		if len(ids) > 0 {
			extra := request
			extraFilter := clone(all)
			delete(extraFilter, "q")
			setArg(&extra, "filter", lit(extraFilter, ""))
			setArg(&extra, "ids", lit(ids, ""))
			ed, err := s.up.dataVars(ctx, g.query(&extra), g.vars)
			if err != nil {
				return nil, err
			}
			seen := map[string]bool{}
			for _, r := range rows {
				seen[str(obj(r)["_stitchInternalId"])] = true
			}
			for _, r := range list(obj(ed["findScenes"])["scenes"]) {
				id := str(obj(r)["_stitchInternalId"])
				if !seen[id] {
					rows = append(rows, r)
					seen[id] = true
				}
			}
		}
	}
	wanted := map[string]*Group{}
	for _, r := range rows {
		if group := c.Members[str(obj(r)["_stitchInternalId"])]; group != nil {
			wanted[group.ID] = group
		}
	}
	// Fetch the same requested fields for every chapter, allowing performer/tag union.
	missing := []any{}
	full := map[string]object{}
	for _, group := range wanted {
		for _, ch := range group.Chapters {
			if full[ch.ID] == nil {
				full[ch.ID] = object{}
				missing = append(missing, ch.ID)
			}
		}
	}
	full, e = s.fetchRows(ctx, g, missing, internal)
	if e != nil {
		return nil, e
	}
	out := []any{}
	seen := map[string]bool{}
	duration, size := 0.0, 0.0
	for _, r := range rows {
		o := obj(r)
		id := str(o["_stitchInternalId"])
		group := c.Members[id]
		if group != nil && (requested == nil || requested[group.VirtualID()]) {
			id = group.VirtualID()
			if seen[id] {
				continue
			}
			o = s.virtualScene(g, group, full, internal)
			duration += s.duration(group)
			size += float64(group.Size)
		} else {
			files := list(o["_stitchInternalFiles"])
			if len(files) > 0 {
				duration += num(obj(files[0])["duration"])
				for _, f := range files {
					v := obj(f)["size"]
					n, _ := strconv.ParseFloat(fmt.Sprint(v), 64)
					size += n
				}
			}
		}
		if seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, o)
	}
	if sortField != "" || sortName == "duration" {
		sort.SliceStable(out, func(i, j int) bool {
			a, b := obj(out[i]), obj(out[j])
			av, bv := a["_stitchInternalSort"], b["_stitchInternalSort"]
			if sortName == "duration" {
				av = durationOf(a)
				bv = durationOf(b)
			}
			cmp := compare(av, bv)
			if cmp == 0 {
				cmp = strings.Compare(str(a["_stitchInternalId"]), str(b["_stitchInternalId"]))
			}
			if str(filter["direction"]) == "DESC" {
				return cmp > 0
			}
			return cmp < 0
		})
	}
	count := len(out)
	if per != -1 {
		start := (page - 1) * per
		if start > count {
			start = count
		}
		end := start + per
		if end > count {
			end = count
		}
		out = out[start:end]
	}
	result := object{}
	for _, sf := range fields(f.SelectionSet) {
		switch sf.Name {
		case "scenes":
			values := []any{}
			for _, r := range out {
				values = append(values, project(g, obj(r), sf.SelectionSet))
			}
			result[key(sf)] = values
		case "count":
			result[key(sf)] = count
		case "duration":
			result[key(sf)] = duration
		case "filesize":
			result[key(sf)] = size
		case "__typename":
			result[key(sf)] = "FindScenesResultType"
		default:
			return nil, fmt.Errorf("unsupported grouped result field %s", sf.Name)
		}
	}
	return result, nil
}
func durationOf(o object) float64 {
	a := list(o["_stitchInternalFiles"])
	if len(a) > 0 {
		return num(obj(a[0])["duration"])
	}
	return 0
}
func compare(a, b any) int {
	if _, ok := a.(float64); ok {
		if num(a) < num(b) {
			return -1
		}
		if num(a) > num(b) {
			return 1
		}
		return 0
	}
	return strings.Compare(strings.ToLower(fmt.Sprint(a)), strings.ToLower(fmt.Sprint(b)))
}
func project(g *gqlContext, o object, sel ast.SelectionSet) object {
	out := object{}
	for _, s := range sel {
		switch f := s.(type) {
		case *ast.InlineFragment:
			if g.enabled(f.Directives) {
				for k, v := range project(g, o, f.SelectionSet) {
					out[k] = v
				}
			}
		case *ast.Field:
			if !g.enabled(f.Directives) {
				continue
			}
			v := o[key(f)]
			if len(f.SelectionSet) > 0 {
				switch x := v.(type) {
				case object:
					v = project(g, x, f.SelectionSet)
				case []any:
					a := []any{}
					for _, x := range x {
						a = append(a, project(g, obj(x), f.SelectionSet))
					}
					v = a
				}
			}
			out[key(f)] = v
		}
	}
	return out
}

func (s *Server) virtualScene(g *gqlContext, group *Group, rows map[string]object, sel ast.SelectionSet) object {
	o := clone(rows[group.Chapters[0].ID])
	state := s.activity.get(group.ID)
	for _, f := range fields(sel) {
		k := key(f)
		switch f.Name {
		case "id":
			o[k] = group.VirtualID()
		case "title":
			o[k] = group.Name
		case "details":
			if group.Description != "" {
				o[k] = group.Description
			}
		case "interactive":
			o[k] = false
		case "resume_time":
			o[k] = state.Resume
		case "play_count":
			o[k] = state.Plays
		case "play_duration":
			o[k] = state.Duration
		case "last_played_at":
			if state.LastPlayed != "" {
				o[k] = state.LastPlayed
			} else {
				o[k] = nil
			}
		case "captions", "scene_markers":
			o[k] = []any{}
		case "sceneStreams":
			o[k] = s.streams(group, f.SelectionSet)
		case "files":
			fs := list(o[k])
			if len(fs) > 0 {
				file := clone(obj(fs[0]))
				for _, ff := range fields(f.SelectionSet) {
					switch ff.Name {
					case "duration":
						file[key(ff)] = s.duration(group)
					case "size":
						file[key(ff)] = strconv.FormatInt(group.Size, 10)
					case "format":
						file[key(ff)] = "hls"
					case "path":
						file[key(ff)] = "stitch://group/" + group.ID
					case "basename":
						file[key(ff)] = group.Name + ".m3u8"
					case "id":
						file[key(ff)] = "stitch-file-" + group.ID
					}
				}
				o[k] = []any{file}
			}
		case "paths":
			paths := clone(obj(o[k]))
			for _, pf := range fields(f.SelectionSet) {
				switch pf.Name {
				case "stream":
					paths[key(pf)] = s.playbackURL(group)
				case "screenshot":
				default:
					paths[key(pf)] = nil
				}
			}
			o[k] = paths
		case "performers", "tags":
			merged := []any{}
			seen := map[string]bool{}
			for _, ch := range group.Chapters {
				for _, v := range list(rows[ch.ID][k]) {
					b, _ := json.Marshal(v)
					id := string(b)
					for _, cf := range fields(f.SelectionSet) {
						if cf.Name == "id" {
							id = fmt.Sprint(obj(v)[key(cf)])
						}
					}
					if !seen[id] {
						seen[id] = true
						merged = append(merged, v)
					}
				}
			}
			o[k] = merged
		}
	}
	return project(g, o, sel)
}
func (s *Server) streams(group *Group, sel ast.SelectionSet) []any {
	stream := object{}
	for _, f := range fields(sel) {
		switch f.Name {
		case "url":
			stream[key(f)] = s.playbackURL(group)
		case "mime_type":
			stream[key(f)] = "application/vnd.apple.mpegurl"
		case "label":
			stream[key(f)] = "HLS (original quality)"
		case "__typename":
			stream[key(f)] = "SceneStreamEndpoint"
		}
	}
	return []any{stream}
}

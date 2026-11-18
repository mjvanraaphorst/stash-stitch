package stitch

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type object = map[string]any
type Upstream struct {
	base   *url.URL
	key    string
	client *http.Client
}

func newUpstream(c Config) *Upstream {
	u, _ := url.Parse(strings.TrimRight(c.StashURL, "/"))
	return &Upstream{u, c.StashAPIKey, &http.Client{Timeout: 90 * time.Second, CheckRedirect: func(r *http.Request, via []*http.Request) error { return http.ErrUseLastResponse }}}
}
func (u *Upstream) endpoint(path string) *url.URL {
	v := *u.base
	v.Path = strings.TrimRight(v.Path, "/") + path
	v.RawQuery = ""
	return &v
}
func (u *Upstream) request(ctx context.Context, method string, target *url.URL, body io.Reader) (*http.Response, error) {
	r, e := http.NewRequestWithContext(ctx, method, target.String(), body)
	if e != nil {
		return nil, e
	}
	r.Header.Set("Content-Type", "application/json")
	if u.key != "" {
		r.Header.Set("ApiKey", u.key)
	}
	return u.client.Do(r)
}
func (u *Upstream) graphql(ctx context.Context, query string, vars object, operation string) (object, error) {
	b, _ := json.Marshal(object{"query": query, "variables": vars, "operationName": operation})
	r, e := u.request(ctx, "POST", u.endpoint("/graphql"), bytes.NewReader(b))
	if e != nil {
		return nil, errors.New("cannot reach Stash")
	}
	defer r.Body.Close()
	if r.StatusCode != 200 {
		return nil, fmt.Errorf("Stash returned HTTP %d", r.StatusCode)
	}
	limited := io.LimitReader(r.Body, 64<<20)
	var out object
	if e = json.NewDecoder(limited).Decode(&out); e != nil {
		return nil, errors.New("Stash response is invalid or exceeds 64 MiB")
	}
	return out, nil
}
func (u *Upstream) data(ctx context.Context, q string) (object, error) {
	return u.dataVars(ctx, q, nil)
}
func (u *Upstream) dataVars(ctx context.Context, q string, vars object) (object, error) {
	out, e := u.graphql(ctx, q, vars, "")
	if e != nil {
		return nil, e
	}
	if a, ok := out["errors"].([]any); ok && len(a) > 0 {
		return nil, errors.New("Stash rejected the generated query; check server/schema compatibility")
	}
	d, ok := out["data"].(map[string]any)
	if !ok {
		return nil, errors.New("Stash returned no data")
	}
	return d, nil
}
func str(v any) string { s, _ := v.(string); return s }
func num(v any) float64 {
	switch n := v.(type) {
	case float64:
		return n
	case int:
		return float64(n)
	case int64:
		return float64(n)
	case uint64:
		return float64(n)
	case json.Number:
		f, _ := n.Float64()
		return f
	}
	return 0
}
func obj(v any) object { o, _ := v.(map[string]any); return o }
func list(v any) []any { a, _ := v.([]any); return a }
func clone(o object) object {
	b, _ := json.Marshal(o)
	var v object
	_ = json.Unmarshal(b, &v)
	return v
}

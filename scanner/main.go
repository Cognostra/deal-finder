package main

import (
	"bufio"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"math/rand/v2"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

type watchSnapshot struct {
	Title        string   `json:"title,omitempty"`
	Price        *float64 `json:"price,omitempty"`
	Currency     string   `json:"currency,omitempty"`
	Etag         string   `json:"etag,omitempty"`
	LastModified string   `json:"lastModified,omitempty"`
	ContentHash  string   `json:"contentHash,omitempty"`
	FetchedAt    string   `json:"fetchedAt,omitempty"`
	RawSnippet   string   `json:"rawSnippet,omitempty"`
}

type itemIn struct {
	ID           string         `json:"id"`
	URL          string         `json:"url"`
	Etag         string         `json:"etag,omitempty"`
	LastModified string         `json:"lastModified,omitempty"`
	LastSnapshot *watchSnapshot `json:"lastSnapshot,omitempty"`
}

type requestV1 struct {
	Version int    `json:"version"`
	Op      string `json:"op"`
	Limits  struct {
		MaxConcurrent        int     `json:"maxConcurrent"`
		MaxBytesPerResponse  int     `json:"maxBytesPerResponse"`
		DefaultMaxRpsPerHost float64 `json:"defaultMaxRpsPerHost"`
		RequestTimeoutMs     int     `json:"requestTimeoutMs"`
		ProxyURL             string  `json:"proxyUrl,omitempty"`
	} `json:"limits"`
	HostPolicy struct {
		AllowedHosts []string `json:"allowedHosts,omitempty"`
		BlockedHosts []string `json:"blockedHosts,omitempty"`
	} `json:"hostPolicy,omitempty"`
	UserAgents []string `json:"userAgents"`
	Items      []itemIn `json:"items"`
}

type fetchMeta struct {
	Status       int    `json:"status"`
	FinalURL     string `json:"finalUrl"`
	BytesRead    int    `json:"bytesRead"`
	Etag         string `json:"etag,omitempty"`
	LastModified string `json:"lastModified,omitempty"`
	NotModified  bool   `json:"notModified,omitempty"`
}

type fetchRow struct {
	WatchID  string         `json:"watchId"`
	URL      string         `json:"url"`
	Ok       bool           `json:"ok"`
	Error    string         `json:"error,omitempty"`
	TimingMs map[string]int `json:"timingMs"`
	Meta     *fetchMeta     `json:"meta,omitempty"`
	Before   *watchSnapshot `json:"before,omitempty"`
	Text     string         `json:"text,omitempty"`
}

type responseV1 struct {
	Version int        `json:"version"`
	Results []fetchRow `json:"results"`
}

func main() {
	stdio := flag.Bool("stdio", false, "read one JSON request line from stdin, write one response line to stdout")
	flag.Parse()
	if !*stdio {
		fmt.Fprintln(os.Stderr, "usage: deal-scanner --stdio")
		os.Exit(2)
	}
	if err := runStdio(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func runStdio() error {
	r := bufio.NewReader(os.Stdin)
	line, err := r.ReadString('\n')
	if err != nil && err != io.EOF {
		return err
	}
	line = strings.TrimSpace(line)
	if line == "" {
		return fmt.Errorf("empty stdin")
	}
	var req requestV1
	if err := json.Unmarshal([]byte(line), &req); err != nil {
		return fmt.Errorf("parse request: %w", err)
	}
	if req.Version != 1 || req.Op != "scan" {
		return fmt.Errorf("unsupported request")
	}
	results := runScan(req)
	out, err := json.Marshal(responseV1{Version: 1, Results: results})
	if err != nil {
		return err
	}
	fmt.Println(string(out))
	return nil
}

func runScan(req requestV1) []fetchRow {
	if req.Limits.MaxConcurrent < 1 {
		req.Limits.MaxConcurrent = 1
	}
	if req.Limits.MaxBytesPerResponse < 4096 {
		req.Limits.MaxBytesPerResponse = 512 * 1024
	}
	if req.Limits.DefaultMaxRpsPerHost < 0.1 {
		req.Limits.DefaultMaxRpsPerHost = 1
	}
	if req.Limits.RequestTimeoutMs < 1000 {
		req.Limits.RequestTimeoutMs = 25000
	}

	transport := &http.Transport{
		MaxIdleConns:        128,
		MaxIdleConnsPerHost: 32,
		IdleConnTimeout:     90 * time.Second,
	}
	if req.Limits.ProxyURL != "" {
		proxyURL, err := url.Parse(req.Limits.ProxyURL)
		if err == nil {
			transport.Proxy = http.ProxyURL(proxyURL)
		}
	}
	client := &http.Client{
		Transport: transport,
		Timeout:   time.Duration(req.Limits.RequestTimeoutMs) * time.Millisecond,
	}
	client.CheckRedirect = func(next *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return fmt.Errorf("deal-hunter: too many redirects while fetching %s", via[0].URL.String())
		}
		if err := validateTargetURL(next.URL, req); err != nil {
			return err
		}
		if err := ensurePublicHostResolution(next.Context(), next.URL.Hostname()); err != nil {
			return err
		}
		return nil
	}

	hostMu := map[string]*sync.Mutex{}
	var hostMuLock sync.Mutex
	interval := time.Duration(float64(time.Second) / req.Limits.DefaultMaxRpsPerHost)
	nextSlot := map[string]time.Time{}
	var slotLock sync.Mutex

	throttle := func(host string) {
		hostMuLock.Lock()
		m, ok := hostMu[host]
		if !ok {
			m = &sync.Mutex{}
			hostMu[host] = m
		}
		hostMuLock.Unlock()
		m.Lock()
		defer m.Unlock()
		slotLock.Lock()
		now := time.Now()
		if t, ok := nextSlot[host]; ok && t.After(now) {
			d := time.Until(t)
			slotLock.Unlock()
			if d > 0 {
				time.Sleep(d)
			}
			slotLock.Lock()
		}
		nextSlot[host] = time.Now().Add(interval)
		slotLock.Unlock()
	}

	uas := req.UserAgents
	if len(uas) == 0 {
		uas = []string{"OpenClaw-DealHunter-scanner/0.1"}
	}

	sem := make(chan struct{}, req.Limits.MaxConcurrent)
	var wg sync.WaitGroup
	mu := sync.Mutex{}
	out := make([]fetchRow, len(req.Items))

	for i, it := range req.Items {
		i, it := i, it
		wg.Add(1)
		go func() {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			t0 := time.Now()
			row := fetchRow{
				WatchID:  it.ID,
				URL:      it.URL,
				TimingMs: map[string]int{"fetch": 0, "parse": 0, "total": 0},
			}

			u, err := url.Parse(it.URL)
			if err != nil {
				row.Ok = false
				row.Error = err.Error()
				row.TimingMs["total"] = int(time.Since(t0).Milliseconds())
				mu.Lock()
				out[i] = row
				mu.Unlock()
				return
			}
			if err := validateTargetURL(u, req); err != nil {
				row.Ok = false
				row.Error = err.Error()
				row.TimingMs["total"] = int(time.Since(t0).Milliseconds())
				mu.Lock()
				out[i] = row
				mu.Unlock()
				return
			}
			resolveCtx, resolveCancel := context.WithTimeout(context.Background(), time.Duration(req.Limits.RequestTimeoutMs)*time.Millisecond)
			if err := ensurePublicHostResolution(resolveCtx, u.Hostname()); err != nil {
				resolveCancel()
				row.Ok = false
				row.Error = err.Error()
				row.TimingMs["total"] = int(time.Since(t0).Milliseconds())
				mu.Lock()
				out[i] = row
				mu.Unlock()
				return
			}
			resolveCancel()
			host := u.Hostname()
			throttle(host)

			tf := time.Now()
			hreq, err := http.NewRequest(http.MethodGet, it.URL, nil)
			if err != nil {
				row.Ok = false
				row.Error = err.Error()
				row.TimingMs["total"] = int(time.Since(t0).Milliseconds())
				mu.Lock()
				out[i] = row
				mu.Unlock()
				return
			}
			hreq.Header.Set("User-Agent", uas[rand.IntN(len(uas))])
			hreq.Header.Set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
			if it.Etag != "" {
				hreq.Header.Set("If-None-Match", it.Etag)
			}
			if it.LastModified != "" {
				hreq.Header.Set("If-Modified-Since", it.LastModified)
			}

			resp, err := client.Do(hreq)
			if err != nil {
				row.Ok = false
				row.Error = wErrstr(err)
				row.TimingMs["fetch"] = int(time.Since(tf).Milliseconds())
				row.TimingMs["total"] = int(time.Since(t0).Milliseconds())
				mu.Lock()
				out[i] = row
				mu.Unlock()
				return
			}
			defer resp.Body.Close()

			meta := &fetchMeta{
				Status:       resp.StatusCode,
				FinalURL:     resp.Request.URL.String(),
				Etag:         resp.Header.Get("ETag"),
				LastModified: resp.Header.Get("Last-Modified"),
			}

			if resp.StatusCode == http.StatusNotModified {
				meta.NotModified = true
				row.Ok = true
				row.Meta = meta
				if it.LastSnapshot != nil {
					row.Before = it.LastSnapshot
				}
				row.TimingMs["fetch"] = int(time.Since(tf).Milliseconds())
				row.TimingMs["total"] = int(time.Since(t0).Milliseconds())
				mu.Lock()
				out[i] = row
				mu.Unlock()
				return
			}

			cap := req.Limits.MaxBytesPerResponse
			lr := io.LimitReader(resp.Body, int64(cap)+1)
			body, err := io.ReadAll(lr)
			if err != nil {
				row.Ok = false
				row.Error = wErrstr(err)
				row.Meta = meta
				row.TimingMs["fetch"] = int(time.Since(tf).Milliseconds())
				row.TimingMs["total"] = int(time.Since(t0).Milliseconds())
				mu.Lock()
				out[i] = row
				mu.Unlock()
				return
			}
			if len(body) > cap {
				body = body[:cap]
			}
			meta.BytesRead = len(body)
			meta.Status = resp.StatusCode

			row.Ok = resp.StatusCode >= 200 && resp.StatusCode < 400
			row.Meta = meta
			if it.LastSnapshot != nil {
				snap := *it.LastSnapshot
				row.Before = &snap
			}
			row.Text = string(body)
			if !row.Ok && row.Error == "" {
				row.Error = fmt.Sprintf("HTTP %d", resp.StatusCode)
			}

			row.TimingMs["fetch"] = int(time.Since(tf).Milliseconds())
			row.TimingMs["total"] = int(time.Since(t0).Milliseconds())
			mu.Lock()
			out[i] = row
			mu.Unlock()
		}()
	}
	wg.Wait()
	return out
}

func wErrstr(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func validateTargetURL(u *url.URL, req requestV1) error {
	if u == nil {
		return fmt.Errorf("deal-hunter: invalid URL")
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return fmt.Errorf("deal-hunter: unsupported URL scheme %q", u.Scheme)
	}

	host := strings.ToLower(strings.TrimSpace(u.Hostname()))
	if host == "" {
		return fmt.Errorf("deal-hunter: URL is missing a hostname: %q", u.String())
	}

	for _, pattern := range req.HostPolicy.BlockedHosts {
		if matchesHostPattern(host, normalizeHostPattern(pattern)) {
			return fmt.Errorf("deal-hunter: blocked URL host %q by blockedHosts policy", host)
		}
	}
	if len(req.HostPolicy.AllowedHosts) > 0 {
		matched := false
		for _, pattern := range req.HostPolicy.AllowedHosts {
			if matchesHostPattern(host, normalizeHostPattern(pattern)) {
				matched = true
				break
			}
		}
		if !matched {
			return fmt.Errorf("deal-hunter: URL host %q is not in allowedHosts policy", host)
		}
	}

	if host == "localhost" || host == "localhost.localdomain" || strings.HasSuffix(host, ".localhost") {
		return fmt.Errorf("deal-hunter: blocked local hostname %q", host)
	}

	ip := net.ParseIP(host)
	if ip == nil && strings.HasPrefix(host, "::ffff:") {
		ip = net.ParseIP(strings.TrimPrefix(host, "::ffff:"))
	}
	if ip != nil {
		if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsMulticast() || ip.IsUnspecified() {
			return fmt.Errorf("deal-hunter: blocked private or non-public IP target %q", host)
		}
	}

	return nil
}

func ensurePublicHostResolution(ctx context.Context, host string) error {
	normalized := strings.ToLower(strings.TrimSpace(host))
	if normalized == "" || net.ParseIP(normalized) != nil {
		return nil
	}
	addrs, err := net.DefaultResolver.LookupIPAddr(ctx, normalized)
	if err != nil {
		return fmt.Errorf("deal-hunter: could not resolve host %q: %w", normalized, err)
	}
	if len(addrs) == 0 {
		return fmt.Errorf("deal-hunter: host %q did not resolve to any address", normalized)
	}
	for _, addr := range addrs {
		ip := addr.IP
		if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsMulticast() || ip.IsUnspecified() {
			return fmt.Errorf("deal-hunter: blocked host %q because it resolves to private or non-public IP %q", normalized, ip.String())
		}
	}
	return nil
}

func normalizeHostPattern(pattern string) string {
	return strings.ToLower(strings.TrimSpace(pattern))
}

func matchesHostPattern(host string, pattern string) bool {
	if pattern == "" {
		return false
	}
	if strings.HasPrefix(pattern, "*.") {
		suffix := strings.TrimPrefix(pattern, "*.")
		return suffix != "" && host != suffix && strings.HasSuffix(host, "."+suffix)
	}
	return host == pattern
}

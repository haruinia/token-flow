package management

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/router-for-me/CLIProxyAPI/v7/internal/config"
)

func TestTokenFlowTraeCallback(t *testing.T) {
	for _, tokenPayload := range []string{"authCodeInfo", "userJwt", "userJwtObject"} {
		t.Run(tokenPayload, func(t *testing.T) {
			state := "trae-contract-" + tokenPayload
			RegisterOAuthSession(state, "trae")
			defer CompleteOAuthSession(state)
			dir := t.TempDir()
			h := NewHandlerWithoutConfigFilePath(&config.Config{AuthDir: dir}, nil)
			router := gin.New()
			router.POST("/oauth-callback", h.PostOAuthCallback)
			query := url.Values{"state": {state}, "host": {"https://api-us-east.trae.ai"}, "userInfo": {`{"UserID":"test-user"}`}}
			if tokenPayload == "authCodeInfo" {
				query.Set(tokenPayload, `{"Token":"test-token","RefreshToken":"test-refresh"}`)
			} else {
				query.Set("userJwt", "test-token")
				query.Set("refreshToken", "test-refresh")
				if tokenPayload == "userJwtObject" {
					query.Set("userJwt", `{"Token":"test-token","TokenExpireAt":1900000000}`)
				}
			}
			body, _ := json.Marshal(map[string]string{"provider": "trae", "redirect_url": "http://127.0.0.1:1455/authorize?" + query.Encode()})
			req := httptest.NewRequest(http.MethodPost, "/oauth-callback", strings.NewReader(string(body)))
			req.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()
			router.ServeHTTP(w, req)
			if w.Code != 200 {
				t.Fatalf("callback rejected: status %d", w.Code)
			}
			raw, err := os.ReadFile(filepath.Join(dir, ".oauth-trae-"+state+".oauth"))
			if err != nil {
				t.Fatal(err)
			}
			var payload oauthCallbackFilePayload
			if err := json.Unmarshal(raw, &payload); err != nil {
				t.Fatal(err)
			}
			var tokens map[string]any
			if err := json.Unmarshal([]byte(payload.AuthCodeInfo), &tokens); err != nil {
				t.Fatal(err)
			}
			if tokens["Token"] != "test-token" || tokens["RefreshToken"] != "test-refresh" || payload.UserInfo != query.Get("userInfo") || payload.Host != query.Get("host") {
				t.Fatal("official callback fields were lost")
			}
		})
	}
}

func TestTokenFlowTraeAuthorizationURL(t *testing.T) {
	h := NewHandlerWithoutConfigFilePath(&config.Config{Port: 8317, AuthDir: t.TempDir()}, nil)
	router := gin.New()
	router.GET("/trae-auth-url", h.RequestTraeToken)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/trae-auth-url", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("authorization start: %d", w.Code)
	}
	var body struct {
		URL   string `json:"url"`
		State string `json:"state"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	defer CompleteOAuthSession(body.State)
	outer, err := url.Parse(body.URL)
	if err != nil {
		t.Fatal(err)
	}
	inner, err := url.Parse(outer.Query().Get("redirect_url"))
	if err != nil {
		t.Fatal(err)
	}
	if inner.Query().Get("auth_callback_url") != "http://127.0.0.1:1455/authorize" || inner.Query().Get("login_trace_id") != body.State || body.State == "" {
		t.Fatal("Trae must use its accepted callback path and correlate loginTraceID")
	}
}

func TestTokenFlowTraeRejectsUntrustedHost(t *testing.T) {
	state := "trae-untrusted-host"
	RegisterOAuthSession(state, "trae")
	defer CompleteOAuthSession(state)
	dir := t.TempDir()
	h := NewHandlerWithoutConfigFilePath(&config.Config{AuthDir: dir}, nil)
	router := gin.New()
	router.POST("/oauth-callback", h.PostOAuthCallback)
	query := url.Values{"state": {state}, "host": {"https://trae.ai.evil.test"}, "userJwt": {"test-token"}, "refreshToken": {"test-refresh"}}
	body, _ := json.Marshal(map[string]string{"provider": "trae", "redirect_url": "http://127.0.0.1:1455/authorize?" + query.Encode()})
	req := httptest.NewRequest(http.MethodPost, "/oauth-callback", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatal("untrusted API host accepted")
	}
	if _, err := os.Stat(filepath.Join(dir, ".oauth-trae-"+state+".oauth")); !os.IsNotExist(err) {
		t.Fatal("untrusted credentials persisted")
	}
}

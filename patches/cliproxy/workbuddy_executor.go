package executor

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/router-for-me/CLIProxyAPI/v7/internal/auth/workbuddy"
	"github.com/router-for-me/CLIProxyAPI/v7/internal/config"
	"github.com/router-for-me/CLIProxyAPI/v7/internal/runtime/executor/helps"
	cliproxyauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
	cliproxyexecutor "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/executor"
	sdktranslator "github.com/router-for-me/CLIProxyAPI/v7/sdk/translator"
	log "github.com/sirupsen/logrus"
)

// WorkBuddyExecutor implements the executor for Tencent WorkBuddy (CodeBuddy) API.
// It wraps OpenAICompatExecutor with WorkBuddy credential resolution, model normalization,
// mandatory streaming protocol handling, and token refresh handling on 401 responses.
type WorkBuddyExecutor struct {
	*OpenAICompatExecutor
	cfg *config.Config
}

// NewWorkBuddyExecutor constructs a new WorkBuddy executor instance.
func NewWorkBuddyExecutor(cfg *config.Config) *WorkBuddyExecutor {
	return &WorkBuddyExecutor{
		OpenAICompatExecutor: NewOpenAICompatExecutor("workbuddy", cfg),
		cfg:                  cfg,
	}
}

// Identifier returns the provider identifier "workbuddy".
func (e *WorkBuddyExecutor) Identifier() string {
	return "workbuddy"
}

// RequestToFormat reports the format expected by the WorkBuddy upstream API.
func (e *WorkBuddyExecutor) RequestToFormat(req cliproxyexecutor.Request, opts cliproxyexecutor.Options) sdktranslator.Format {
	if opts.Alt == "responses/compact" && !opts.Stream {
		return sdktranslator.FormatOpenAIResponse
	}
	return sdktranslator.FormatOpenAI
}

// PrepareRequest injects WorkBuddy credentials and headers into the outgoing HTTP request.
func (e *WorkBuddyExecutor) PrepareRequest(req *http.Request, auth *cliproxyauth.Auth) error {
	adaptedAuth := e.adaptAuth(auth)
	return e.OpenAICompatExecutor.PrepareRequest(req, adaptedAuth)
}

// HttpRequest prepares and sends an HTTP request using WorkBuddy credentials.
func (e *WorkBuddyExecutor) HttpRequest(ctx context.Context, auth *cliproxyauth.Auth, req *http.Request) (*http.Response, error) {
	adaptedAuth := e.adaptAuth(auth)
	return e.OpenAICompatExecutor.HttpRequest(ctx, adaptedAuth, req)
}

// Execute routes this source through the shared Responses representation.
func (e *WorkBuddyExecutor) Execute(ctx context.Context, auth *cliproxyauth.Auth, req cliproxyexecutor.Request, opts cliproxyexecutor.Options) (cliproxyexecutor.Response, error) {
	return executeAgentResponse(ctx, auth, req, opts, e.executeNativeStream)
}

func (e *WorkBuddyExecutor) ExecuteStream(ctx context.Context, auth *cliproxyauth.Auth, req cliproxyexecutor.Request, opts cliproxyexecutor.Options) (*cliproxyexecutor.StreamResult, error) {
	return executeAgentResponseStream(ctx, auth, req, opts, e.executeNativeStream)
}

// ExecuteStream performs a streaming chat completion request to WorkBuddy, with auto-refresh on 401.
func (e *WorkBuddyExecutor) executeNativeStream(ctx context.Context, auth *cliproxyauth.Auth, req cliproxyexecutor.Request, opts cliproxyexecutor.Options) (*cliproxyexecutor.StreamResult, error) {
	var accessToken, uid string
	if auth != nil && auth.Metadata != nil {
		if tok, ok := auth.Metadata["access_token"].(string); ok && strings.TrimSpace(tok) != "" {
			accessToken = strings.TrimSpace(tok)
		} else if tok, ok := auth.Metadata["accessToken"].(string); ok && strings.TrimSpace(tok) != "" {
			accessToken = strings.TrimSpace(tok)
		}
		if u, ok := auth.Metadata["uid"].(string); ok && strings.TrimSpace(u) != "" {
			uid = strings.TrimSpace(u)
		}
	}
	if accessToken == "" && auth != nil && auth.Attributes != nil {
		accessToken = strings.TrimSpace(auth.Attributes["api_key"])
		if uid == "" {
			uid = strings.TrimSpace(auth.Attributes["uid"])
		}
	}
	if accessToken == "" {
		return nil, statusErr{code: http.StatusUnauthorized, msg: "workbuddy: access token missing"}
	}

	reqBody, errBody := helps.PrepareWorkBuddyRequestBody(req.Payload, req.Model)
	if errBody != nil {
		return nil, fmt.Errorf("workbuddy: failed to prepare request body: %w", errBody)
	}

	chatURL := helps.WorkBuddyDefaultChatURL
	if auth != nil && auth.Attributes != nil && strings.TrimSpace(auth.Attributes["chat_url"]) != "" {
		chatURL = strings.TrimSpace(auth.Attributes["chat_url"])
	}

	headers := helps.BuildWorkBuddyAuthHeaders(accessToken, uid)

	httpReq, errReq := http.NewRequestWithContext(ctx, http.MethodPost, chatURL, bytes.NewReader(reqBody))
	if errReq != nil {
		return nil, errReq
	}
	for k, v := range headers {
		httpReq.Header.Set(k, v)
	}

	httpClient := helps.NewProxyAwareHTTPClient(ctx, e.cfg, auth, 0)
	resp, errDo := httpClient.Do(httpReq)
	if errDo != nil {
		return nil, errDo
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		bodyBytes, _ := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		if (resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden) && canRefreshWorkBuddy(auth) {
			if refreshedAuth, errRefresh := e.Refresh(ctx, auth); errRefresh == nil {
				refreshedAuth = refreshedAuth.Clone()
				delete(refreshedAuth.Metadata, "refresh_token")
				delete(refreshedAuth.Metadata, "refreshToken")
				return e.executeNativeStream(ctx, refreshedAuth, req, opts)
			}
		}
		return nil, statusErr{code: resp.StatusCode, msg: fmt.Sprintf("workbuddy upstream error: %d: %s", resp.StatusCode, string(bodyBytes))}
	}

	return readAgentChatStream(ctx, resp, "workbuddy"), nil
}

// CountTokens calculates the token count for a WorkBuddy request.
func (e *WorkBuddyExecutor) CountTokens(ctx context.Context, auth *cliproxyauth.Auth, req cliproxyexecutor.Request, opts cliproxyexecutor.Options) (cliproxyexecutor.Response, error) {
	adaptedAuth := e.adaptAuth(auth)
	return e.OpenAICompatExecutor.CountTokens(ctx, adaptedAuth, req, opts)
}

// adaptAuth clones auth and injects WorkBuddy-specific defaults for baseURL and apiKey.
func (e *WorkBuddyExecutor) adaptAuth(auth *cliproxyauth.Auth) *cliproxyauth.Auth {
	if auth == nil {
		return nil
	}
	cloned := *auth
	attrs := make(map[string]string, len(auth.Attributes)+4)
	for k, v := range auth.Attributes {
		attrs[k] = v
	}

	// Resolve API Key / Token
	apiKey := strings.TrimSpace(attrs["api_key"])
	if apiKey == "" && auth.Metadata != nil {
		if token, ok := auth.Metadata["access_token"].(string); ok && strings.TrimSpace(token) != "" {
			apiKey = strings.TrimSpace(token)
		} else if token, ok := auth.Metadata["accessToken"].(string); ok && strings.TrimSpace(token) != "" {
			apiKey = strings.TrimSpace(token)
		}
	}
	attrs["api_key"] = apiKey
	cloned.Attributes = attrs
	return &cloned
}

func canRefreshWorkBuddy(auth *cliproxyauth.Auth) bool {
	if auth == nil || auth.Metadata == nil {
		return false
	}
	if v, ok := auth.Metadata["refresh_token"].(string); ok && strings.TrimSpace(v) != "" {
		return true
	}
	if v, ok := auth.Metadata["refreshToken"].(string); ok && strings.TrimSpace(v) != "" {
		return true
	}
	return false
}

// Refresh refreshes the WorkBuddy access token using its refresh token.
func (e *WorkBuddyExecutor) Refresh(ctx context.Context, auth *cliproxyauth.Auth) (*cliproxyauth.Auth, error) {
	if auth == nil || auth.Metadata == nil {
		return nil, fmt.Errorf("workbuddy executor: auth is nil")
	}
	refreshToken := ""
	if v, ok := auth.Metadata["refresh_token"].(string); ok && strings.TrimSpace(v) != "" {
		refreshToken = strings.TrimSpace(v)
	} else if v, ok := auth.Metadata["refreshToken"].(string); ok && strings.TrimSpace(v) != "" {
		refreshToken = strings.TrimSpace(v)
	}
	if refreshToken == "" {
		return auth, nil
	}

	authSvc := workbuddy.NewWorkBuddyAuth(e.cfg)
	td, err := authSvc.RefreshToken(ctx, refreshToken)
	if err != nil {
		log.Warnf("workbuddy executor: failed to refresh token: %v", err)
		return nil, err
	}

	auth.Metadata["access_token"] = td.AccessToken
	auth.Metadata["accessToken"] = td.AccessToken
	if td.RefreshToken != "" {
		auth.Metadata["refresh_token"] = td.RefreshToken
		auth.Metadata["refreshToken"] = td.RefreshToken
	}
	if td.ExpiresAt > 0 {
		auth.Metadata["expired"] = time.Unix(td.ExpiresAt, 0).UTC().Format(time.RFC3339)
		auth.Metadata["expiresAt"] = td.ExpiresAt
	}
	auth.Metadata["last_refresh"] = time.Now().Format(time.RFC3339)

	// Save updated token to file if storage is present
	if auth.Storage != nil {
		if setter, ok := auth.Storage.(interface{ SetMetadata(map[string]any) }); ok {
			setter.SetMetadata(auth.Metadata)
		}
		if path, ok := auth.Attributes[cliproxyauth.AttributePath]; ok && path != "" {
			if errSave := auth.Storage.SaveTokenToFile(path); errSave != nil {
				log.Warnf("workbuddy executor: failed to save refreshed token to %s: %v", path, errSave)
			}
		}
	}
	return auth, nil
}

package zcode

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

// CLIFlow uses ZCode's registered server callback, not an invented loopback URI.
// The poll token is private and must never be returned to the desktop renderer.
type CLIFlow struct {
	URL       string
	State     string
	ExpiresAt time.Time
	Interval  time.Duration
	flowID    string
	pollToken string
}

func (a *ZCodeAuth) cliRequest(ctx context.Context, method, target, token string, body []byte, result any) error {
	req, err := http.NewRequestWithContext(ctx, method, target, bytes.NewReader(body))
	if err != nil {
		return err
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	// Never forward polling credentials through an unexpected redirect.
	client := *a.httpClient
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := client.Do(req)
	if err != nil {
		return errors.New("ZCode authorization service is unavailable")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("ZCode authorization service returned HTTP %d", resp.StatusCode)
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(result); err != nil {
		return errors.New("invalid ZCode authorization response")
	}
	return nil
}

func (a *ZCodeAuth) StartCLIFlow(ctx context.Context) (*CLIFlow, error) {
	random := make([]byte, 32)
	if _, err := rand.Read(random); err != nil {
		return nil, err
	}
	flow := &CLIFlow{pollToken: hex.EncodeToString(random)}
	var result struct {
		Code int `json:"code"`
		Data struct {
			FlowID    string `json:"flow_id"`
			URL       string `json:"authorize_url"`
			ExpiresAt int64  `json:"expires_at"`
			Interval  int64  `json:"poll_interval_sec"`
		} `json:"data"`
	}
	if err := a.cliRequest(ctx, http.MethodPost, ZCodeInitURL, flow.pollToken, []byte(`{"provider":"zai"}`), &result); err != nil {
		return nil, err
	}
	data := result.Data
	u, err := url.Parse(data.URL)
	if err != nil || result.Code != 0 || data.FlowID == "" || u.Scheme != "https" || u.Host != "chat.z.ai" || u.User != nil || u.Fragment != "" || u.Path != "/api/oauth/authorize" || u.Query().Get("redirect_uri") != "https://zcode.z.ai/api/v1/oauth/cli/callback/zai" || u.Query().Get("state") == "" {
		return nil, errors.New("invalid ZCode authorization session")
	}
	flow.URL, flow.State, flow.flowID = data.URL, u.Query().Get("state"), data.FlowID
	flow.ExpiresAt, flow.Interval = time.Unix(data.ExpiresAt, 0), time.Duration(data.Interval)*time.Second
	if !flow.ExpiresAt.After(time.Now()) || flow.Interval < time.Second || flow.Interval >= time.Until(flow.ExpiresAt) {
		return nil, errors.New("invalid ZCode authorization lifetime")
	}
	return flow, nil
}

func (a *ZCodeAuth) PollCLIFlow(ctx context.Context, flow *CLIFlow) (*ZCodeTokenStorage, error) {
	if !flow.ExpiresAt.After(time.Now()) {
		return nil, errors.New("ZCode authorization expired")
	}
	var result struct {
		Code int `json:"code"`
		Data struct {
			Status string `json:"status"`
			Token  string `json:"token"`
			ZAI    struct {
				AccessToken  string `json:"access_token"`
				RefreshToken string `json:"refresh_token"`
				ExpiresIn    int64  `json:"expires_in"`
			} `json:"zai"`
			User struct {
				ID    string `json:"user_id"`
				Email string `json:"email"`
			} `json:"user"`
		} `json:"data"`
	}
	if err := a.cliRequest(ctx, http.MethodGet, ZCodePollURL+"/"+url.PathEscape(flow.flowID), flow.pollToken, nil, &result); err != nil {
		return nil, err
	}
	data := result.Data
	if result.Code != 0 {
		return nil, errors.New("ZCode authorization failed")
	}
	if data.Status == "pending" {
		return nil, ErrDeviceFlowPending
	}
	if data.Status != "ready" || data.ZAI.AccessToken == "" || data.Token == "" || data.User.ID == "" {
		return nil, errors.New("ZCode authorization returned incomplete credentials")
	}
	storage := &ZCodeTokenStorage{AccessToken: data.ZAI.AccessToken, RefreshToken: data.ZAI.RefreshToken, JWT: data.Token, UID: data.User.ID, Email: data.User.Email, Provider: "zai", Type: "zcode", TokenType: "Bearer"}
	// A chat OAuth token is not a model API credential. Match the official
	// client's mandatory business-token exchange before marking login complete.
	var business struct {
		Code    json.Number `json:"code"`
		Success *bool       `json:"success"`
		Data    struct {
			AccessToken      string `json:"access_token"`
			AccessTokenCamel string `json:"accessToken"`
			ExpiresIn        int64  `json:"expires_in"`
		} `json:"data"`
	}
	body, err := json.Marshal(map[string]string{"token": data.ZAI.AccessToken})
	if err != nil {
		return nil, err
	}
	if err := a.cliRequest(ctx, http.MethodPost, ZCodeBusinessLoginURL, "", body, &business); err != nil {
		return nil, err
	}
	if (business.Code != "" && business.Code != "0" && business.Code != "200") || (business.Success != nil && !*business.Success) {
		return nil, errors.New("ZCode business authorization failed")
	}
	storage.AccessToken = business.Data.AccessToken
	if storage.AccessToken == "" {
		storage.AccessToken = business.Data.AccessTokenCamel
	}
	if storage.AccessToken == "" {
		return nil, errors.New("ZCode business authorization returned no token")
	}
	if business.Data.ExpiresIn > 0 {
		storage.Expired = time.Now().Add(time.Duration(business.Data.ExpiresIn) * time.Second).UTC().Format(time.RFC3339)
	}
	return storage, nil
}

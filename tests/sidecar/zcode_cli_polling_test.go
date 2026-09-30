package zcode

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

type cliTransport func(*http.Request) (*http.Response, error)

func (f cliTransport) RoundTrip(req *http.Request) (*http.Response, error) { return f(req) }

func TestTokenFlowZCodeCLIPolling(t *testing.T) {
	var pollToken string
	status := "pending"
	businessOK := false
	auth := NewZCodeAuth(nil)
	auth.httpClient.Transport = cliTransport(func(req *http.Request) (*http.Response, error) {
		var body string
		switch req.URL.String() {
		case ZCodeInitURL:
			pollToken = strings.TrimPrefix(req.Header.Get("Authorization"), "Bearer ")
			if len(pollToken) != 64 {
				t.Fatal("missing private polling token")
			}
			body = fmt.Sprintf(`{"code":0,"data":{"flow_id":"fixture-flow","authorize_url":"https://chat.z.ai/api/oauth/authorize?state=fixture-state&redirect_uri=https%%3A%%2F%%2Fzcode.z.ai%%2Fapi%%2Fv1%%2Foauth%%2Fcli%%2Fcallback%%2Fzai","expires_at":%d,"poll_interval_sec":2}}`, time.Now().Add(time.Minute).Unix())
		case ZCodePollURL + "/fixture-flow":
			if req.Header.Get("Authorization") != "Bearer "+pollToken {
				t.Fatal("polling token changed")
			}
			body = fmt.Sprintf(`{"code":0,"data":{"status":%q,"token":"zcode-jwt","zai":{"access_token":"chat-oauth"},"user":{"user_id":"test-user","email":"user@example.test"}}}`, status)
		case ZCodeBusinessLoginURL:
			var input map[string]string
			if err := json.NewDecoder(req.Body).Decode(&input); err != nil {
				t.Fatal(err)
			}
			if input["token"] != "chat-oauth" || req.Header.Get("Authorization") != "" {
				t.Fatal("incorrect business-token exchange")
			}
			body = `{"code":401,"success":false,"data":{"access_token":"must-not-save"}}`
			if businessOK {
				body = `{"code":200,"data":{"access_token":"model-business-token","expires_in":3600}}`
			}
		default:
			t.Fatalf("unexpected endpoint %s", req.URL.Host)
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}, nil
	})
	flow, err := auth.StartCLIFlow(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if flow.State != "fixture-state" || flow.Interval != 2*time.Second {
		t.Fatal("incorrect session")
	}
	if _, err := auth.PollCLIFlow(context.Background(), flow); err != ErrDeviceFlowPending {
		t.Fatal("pending must not create credentials")
	}
	status = "ready"
	if _, err := auth.PollCLIFlow(context.Background(), flow); err == nil {
		t.Fatal("failed business exchange must not save chat OAuth as a model token")
	}
	businessOK = true
	storage, err := auth.PollCLIFlow(context.Background(), flow)
	if err != nil {
		t.Fatal(err)
	}
	if storage.AccessToken != "model-business-token" || storage.JWT != "zcode-jwt" || storage.UID != "test-user" || storage.Expired == "" {
		t.Fatal("incorrect saved credentials")
	}
	flow.ExpiresAt = time.Now().Add(-time.Second)
	if _, err := auth.PollCLIFlow(context.Background(), flow); err == nil {
		t.Fatal("expired flow accepted")
	}
}

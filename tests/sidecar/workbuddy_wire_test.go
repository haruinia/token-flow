package executor

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/router-for-me/CLIProxyAPI/v7/internal/config"
	_ "github.com/router-for-me/CLIProxyAPI/v7/internal/translator"
	cliproxyauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
	cliproxyexecutor "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/executor"
	sdktranslator "github.com/router-for-me/CLIProxyAPI/v7/sdk/translator"
	"github.com/tidwall/gjson"
)

func TestWorkBuddyPolicyBlockIsNotAuthenticationFailure(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.WriteHeader(http.StatusForbidden)
		fmt.Fprint(w, `{"code":11128,"msg":"private channel details","requestId":"private-id"}`)
	}))
	defer server.Close()
	auth := &cliproxyauth.Auth{Provider: "workbuddy", Metadata: map[string]any{"access_token": "synthetic", "refresh_token": "must-not-refresh"}, Attributes: map[string]string{"chat_url": server.URL}}
	req := cliproxyexecutor.Request{Model: "glm-5.1", Payload: []byte(`{"messages":[{"role":"user","content":"hello"}]}`)}
	_, err := NewWorkBuddyExecutor(&config.Config{}).Execute(context.Background(), auth, req, cliproxyexecutor.Options{SourceFormat: sdktranslator.FormatOpenAI})
	if e, ok := err.(statusErr); !ok || e.code != 400 || gjson.Get(e.msg, "error.code").String() != "a2a_source_policy_blocked" || strings.Contains(e.msg, "private") || calls != 1 {
		t.Fatalf("policy rejection was not classified safely: calls=%d err=%v", calls, err)
	}
}

func TestWorkBuddyAgentContextRoundTrip(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		for path, want := range map[string]string{"tools.0.function.name": "lookup", "tools.0.function.parameters.type": "object", "max_tokens": "64", "model": "glm-5.1", "stream": "true"} {
			if got := gjson.GetBytes(body, path).String(); got != want {
				t.Errorf("native %s = %q, want %q", path, got, want)
			}
		}
		var system, call, result bool
		for _, m := range gjson.GetBytes(body, "messages").Array() {
			if (m.Get("role").String() == "system" || m.Get("role").String() == "developer") && strings.Contains(m.Get("content").String(), "fixture-system") {
				system = true
			}
			if m.Get("role").String() == "assistant" && m.Get("tool_calls.0.function.name").String() == "lookup" && m.Get("tool_calls.0.id").String() == "call_fixture" {
				call = true
			}
			if m.Get("role").String() == "tool" && m.Get("tool_call_id").String() == "call_fixture" && strings.Contains(m.Get("content").String(), "fixture-result") {
				result = true
			}
		}
		if !system || !call || !result {
			t.Errorf("agent context lost: system=%v call=%v result=%v, fixture payload=%s", system, call, result, body)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"id\":\"fixture\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"OK\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
	}))
	defer server.Close()
	req := cliproxyexecutor.Request{Model: "glm-5.1", Payload: []byte(`{"model":"glm-5.1","max_tokens":64,"system":"fixture-system","tools":[{"name":"lookup","input_schema":{"type":"object","properties":{"path":{"type":"string"}}}}],"messages":[{"role":"user","content":"use lookup"},{"role":"assistant","content":[{"type":"tool_use","id":"call_fixture","name":"lookup","input":{"path":"README.md"}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"call_fixture","content":"fixture-result"}]}]}`)}
	auth := &cliproxyauth.Auth{Provider: "workbuddy", Metadata: map[string]any{"access_token": "synthetic"}, Attributes: map[string]string{"chat_url": server.URL}}
	_, err := NewWorkBuddyExecutor(&config.Config{}).Execute(context.Background(), auth, req, cliproxyexecutor.Options{SourceFormat: sdktranslator.FormatClaude, OriginalRequest: req.Payload})
	if err != nil {
		t.Fatal(err)
	}
}

func TestWorkBuddyCancelledStreamClosesUpstream(t *testing.T) {
	closed := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"id\":\"fixture\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"first\"}}]}\n\n")
		w.(http.Flusher).Flush()
		<-r.Context().Done()
		close(closed)
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	auth := &cliproxyauth.Auth{Provider: "workbuddy", Metadata: map[string]any{"access_token": "synthetic"}, Attributes: map[string]string{"chat_url": server.URL}}
	req := cliproxyexecutor.Request{Model: "glm-5.1", Payload: []byte(`{"messages":[{"role":"user","content":"hello"}]}`)}
	stream, err := NewWorkBuddyExecutor(&config.Config{}).ExecuteStream(ctx, auth, req, cliproxyexecutor.Options{SourceFormat: sdktranslator.FormatClaude})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-stream.Chunks:
	case <-ctx.Done():
		t.Fatal("no first event")
	}
	cancel()
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("cancelled client left upstream running")
	}
	for chunk := range stream.Chunks {
		if strings.Contains(string(chunk.Payload), "message_stop") {
			t.Fatal("cancelled stream fabricated completion")
		}
	}
}

func TestWorkBuddyClaudeWireFormat(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		for _, chunk := range []string{`{"id":"fixture","model":"glm-5.1","choices":[{"index":0,"delta":{"role":"assistant","content":"OK"},"finish_reason":null}]}`, `{"id":"fixture","model":"glm-5.1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":2,"total_tokens":9}}`} {
			envelope := chunk
			fmt.Fprintf(w, "data: %s\n\n", envelope)
		}
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer server.Close()
	exec := NewWorkBuddyExecutor(&config.Config{})
	auth := &cliproxyauth.Auth{ID: "fixture", Provider: "workbuddy", Attributes: map[string]string{"chat_url": server.URL}, Metadata: map[string]any{"access_token": "synthetic"}}
	req := cliproxyexecutor.Request{Model: "glm-5.1", Payload: []byte(`{"model":"glm-5.1","messages":[{"role":"user","content":"Reply OK"}],"max_tokens":16}`)}
	opts := cliproxyexecutor.Options{SourceFormat: sdktranslator.FormatClaude, OriginalRequest: req.Payload}
	t.Run("stream", func(t *testing.T) {
		result, err := exec.ExecuteStream(context.Background(), auth, req, opts)
		if err != nil {
			t.Fatal(err)
		}
		var wire strings.Builder
		for chunk := range result.Chunks {
			if chunk.Err != nil {
				t.Fatal(chunk.Err)
			}
			wire.Write(chunk.Payload)
		}
		for _, expected := range []string{"event: message_start", "event: content_block_delta", "event: message_stop"} {
			if !strings.Contains(wire.String(), expected) {
				t.Errorf("missing %s in Claude stream: %s", expected, wire.String())
			}
		}
	})
	t.Run("nonstream", func(t *testing.T) {
		result, err := exec.Execute(context.Background(), auth, req, opts)
		if err != nil {
			t.Fatal(err)
		}
		if gjson.GetBytes(result.Payload, "type").String() != "message" {
			t.Fatalf("not an Anthropic Message: %s", result.Payload)
		}
		if gjson.GetBytes(result.Payload, "content.0.text").String() != "OK" {
			t.Fatalf("missing text: %s", result.Payload)
		}
	})
	t.Run("responses", func(t *testing.T) {
		req.Payload = []byte(`{"model":"glm-5.1","input":"Reply OK","max_output_tokens":16}`)
		opts = cliproxyexecutor.Options{SourceFormat: sdktranslator.FormatOpenAIResponse, OriginalRequest: req.Payload}
		result, err := exec.Execute(context.Background(), auth, req, opts)
		if err != nil {
			t.Fatal(err)
		}
		if gjson.GetBytes(result.Payload, "object").String() != "response" || gjson.GetBytes(result.Payload, "output.0.content.0.text").String() != "OK" {
			t.Fatalf("invalid Responses output: %s", result.Payload)
		}
		stream, err := exec.ExecuteStream(context.Background(), auth, req, opts)
		if err != nil {
			t.Fatal(err)
		}
		var wire strings.Builder
		for chunk := range stream.Chunks {
			if chunk.Err != nil {
				t.Fatal(chunk.Err)
			}
			wire.Write(chunk.Payload)
		}
		for _, expected := range []string{"response.created", "response.output_text.delta", "response.completed"} {
			if !strings.Contains(wire.String(), expected) {
				t.Errorf("missing %s in Responses stream: %s", expected, wire.String())
			}
		}
	})
}

func TestWorkBuddyToolCallAndInvalidStream(t *testing.T) {
	for _, mode := range []string{"tool", "empty", "truncated", "premature-done", "wrapped-done", "json-error"} {
		t.Run(mode, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				if mode == "json-error" {
					fmt.Fprint(w, `{"error":{"message":"private upstream diagnostic"}}`)
					return
				}
				if mode == "empty" {
					fmt.Fprint(w, "data: [DONE]\n\n")
					return
				}
				chunks := []string{`{"id":"fixture-tool","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_new","type":"function","function":{"name":"lookup","arguments":"{\"path\":"}}]},"finish_reason":null}]}`}
				if mode == "tool" {
					chunks = append(chunks, `{"id":"fixture-tool","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"README.md\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":11,"completion_tokens":3,"total_tokens":14}}`)
				}
				for _, chunk := range chunks {
					envelope := chunk
					fmt.Fprintf(w, "data: %s\n\n", envelope)
				}
				if mode == "wrapped-done" {
					fmt.Fprint(w, "data: {\"body\":\"[DONE]\"}\n\n")
				}
				if mode == "tool" || mode == "premature-done" {
					fmt.Fprint(w, "data: [DONE]\n\n")
				}
			}))
			defer server.Close()
			exec := NewWorkBuddyExecutor(&config.Config{})
			auth := &cliproxyauth.Auth{ID: "fixture", Provider: "workbuddy", Attributes: map[string]string{"chat_url": server.URL}, Metadata: map[string]any{"access_token": "synthetic"}}
			req := cliproxyexecutor.Request{Model: "glm-5.1", Payload: []byte(`{"model":"glm-5.1","stream":true,"system":"fixture-system","messages":[{"role":"user","content":"use lookup"}],"tools":[{"name":"lookup","description":"fixture","input_schema":{"type":"object","properties":{"path":{"type":"string"}}}}],"max_tokens":64}`)}
			opts := cliproxyexecutor.Options{SourceFormat: sdktranslator.FormatClaude, OriginalRequest: req.Payload, Stream: true}
			result, err := exec.Execute(context.Background(), auth, req, opts)
			if mode != "tool" {
				if err == nil {
					t.Fatalf("invalid %s stream accepted: %s", mode, result.Payload)
				}
				stream, streamErr := exec.ExecuteStream(context.Background(), auth, req, opts)
				if streamErr != nil {
					t.Fatal(streamErr)
				}
				failed := false
				for chunk := range stream.Chunks {
					if chunk.Err != nil {
						failed = true
					}
					if strings.Contains(string(chunk.Payload), "event: message_stop") {
						t.Fatal("invalid stream fabricated completion")
					}
				}
				if !failed {
					t.Fatal("invalid streaming response accepted")
				}
				if strings.Contains(err.Error(), "private upstream") {
					t.Fatal("upstream diagnostic exposed")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			for path, want := range map[string]string{"type": "message", "stop_reason": "tool_use", "content.0.type": "tool_use", "content.0.id": "call_new", "content.0.name": "lookup", "content.0.input.path": "README.md", "usage.input_tokens": "11", "usage.output_tokens": "3"} {
				if got := gjson.GetBytes(result.Payload, path).String(); got != want {
					t.Errorf("%s = %q, want %q", path, got, want)
				}
			}
			stream, err := exec.ExecuteStream(context.Background(), auth, req, opts)
			if err != nil {
				t.Fatal(err)
			}
			var wire strings.Builder
			for chunk := range stream.Chunks {
				if chunk.Err != nil {
					t.Fatal(chunk.Err)
				}
				wire.Write(chunk.Payload)
			}
			for _, want := range []string{"event: message_start", `"type":"tool_use"`, `"type":"input_json_delta"`, `"stop_reason":"tool_use"`, "event: message_stop"} {
				if !strings.Contains(wire.String(), want) {
					t.Errorf("missing %s in tool stream", want)
				}
			}
		})
	}
}

// These providers share the Responses bridge; check all supported input codecs.
func TestWorkBuddyQoderBridgeSampling(t *testing.T) {
	for _, format := range []sdktranslator.Format{sdktranslator.FormatClaude, sdktranslator.FormatOpenAI, sdktranslator.FormatOpenAIResponse} {
		t.Run(string(format), func(t *testing.T) {
			req := cliproxyexecutor.Request{Model: "fixture", Payload: []byte(`{"model":"fixture","messages":[{"role":"user","content":"hello"}],"input":"hello","temperature":0,"top_p":0.8}`)}
			native := func(ctx context.Context, a *cliproxyauth.Auth, r cliproxyexecutor.Request, o cliproxyexecutor.Options) (*cliproxyexecutor.StreamResult, error) {
				for path, want := range map[string]string{"temperature": "0", "top_p": "0.8"} {
					value := gjson.GetBytes(r.Payload, path)
					if !value.Exists() || value.String() != want {
						t.Errorf("native %s=%s, want %s", path, value.Raw, want)
					}
				}
				return readAgentChatStream(ctx, &http.Response{Header: http.Header{}, Body: io.NopCloser(strings.NewReader("data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"OK\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n"))}, "fixture"), nil
			}
			_, err := executeAgentResponse(context.Background(), nil, req, cliproxyexecutor.Options{SourceFormat: format}, native)
			if err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestWorkBuddyQoderCompactRejectedBeforeTransport(t *testing.T) {
	native := func(context.Context, *cliproxyauth.Auth, cliproxyexecutor.Request, cliproxyexecutor.Options) (*cliproxyexecutor.StreamResult, error) {
		t.Fatal("unsupported compaction reached provider")
		return nil, nil
	}
	opts := cliproxyexecutor.Options{SourceFormat: sdktranslator.FormatOpenAIResponse, Alt: "responses/compact"}
	req := cliproxyexecutor.Request{Model: "fixture", Payload: []byte(`{"input":"hello"}`)}
	_, err := executeAgentResponse(context.Background(), nil, req, opts, native)
	if e, ok := err.(statusErr); !ok || e.code != 400 || !strings.Contains(e.msg, "not supported") {
		t.Fatalf("expected unsupported compaction, got %v", err)
	}
	_, _, err = startAgentResponses(context.Background(), nil, req, opts, native)
	if err == nil {
		t.Fatal("streaming compaction accepted")
	}
}

// Both source executors share this exact boundary. Assert the native request
// and the translated reply together, not only individual codec helpers.
func TestWorkBuddySharedToolMatrix(t *testing.T) {
	for _, tc := range []struct {
		name   string
		format sdktranslator.Format
		body   string
		choice string
	}{
		{"responses forced", sdktranslator.FormatOpenAIResponse, `{"input":"read","tools":[{"type":"function","name":"read","parameters":{"type":"object"}}],"tool_choice":{"type":"function","name":"read"},"parallel_tool_calls":false}`, "read"},
		{"chat forced", sdktranslator.FormatOpenAI, `{"messages":[{"role":"user","content":"read"}],"tools":[{"type":"function","function":{"name":"read","parameters":{"type":"object"}}}],"tool_choice":{"type":"function","function":{"name":"read"}},"parallel_tool_calls":false}`, "read"},
		{"claude forced", sdktranslator.FormatClaude, `{"messages":[{"role":"user","content":"read"}],"tools":[{"name":"read","input_schema":{"type":"object"}}],"tool_choice":{"type":"tool","name":"read","disable_parallel_tool_use":true}}`, "read"},
		{"custom forced", sdktranslator.FormatOpenAIResponse, `{"input":"patch","tools":[{"type":"custom","name":"patch"}],"tool_choice":{"type":"custom","name":"patch"},"parallel_tool_calls":false}`, "patch"},
		{"namespaced forced", sdktranslator.FormatOpenAIResponse, `{"input":"read","tools":[{"type":"namespace","name":"fs","tools":[{"type":"function","name":"read","parameters":{"type":"object"}}]}],"tool_choice":{"type":"function","name":"read","namespace":"fs"},"parallel_tool_calls":false}`, "fs__read"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := cliproxyexecutor.Request{Model: "model", Payload: []byte(tc.body)}
			native := func(ctx context.Context, _ *cliproxyauth.Auth, r cliproxyexecutor.Request, _ cliproxyexecutor.Options) (*cliproxyexecutor.StreamResult, error) {
				if got := gjson.GetBytes(r.Payload, "tool_choice.function.name").String(); got != tc.choice {
					t.Fatalf("forced choice=%q want=%q body=%s", got, tc.choice, r.Payload)
				}
				if gjson.GetBytes(r.Payload, "parallel_tool_calls").Bool() {
					t.Fatal("parallel restriction lost")
				}
				wire := `data: {"id":"fixture","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}` + "\n\ndata: [DONE]\n\n"
				return readAgentChatStream(ctx, &http.Response{Body: io.NopCloser(strings.NewReader(wire)), Header: make(http.Header)}, "fixture"), nil
			}
			_, err := executeAgentResponse(context.Background(), nil, req, cliproxyexecutor.Options{SourceFormat: tc.format}, native)
			if err != nil {
				t.Fatal(err)
			}
		})
	}
}
func TestWorkBuddySharedParallelAndCustomRoundTrip(t *testing.T) {
	for _, format := range []sdktranslator.Format{sdktranslator.FormatOpenAIResponse, sdktranslator.FormatClaude, sdktranslator.FormatOpenAI} {
		t.Run(string(format), func(t *testing.T) {
			body := `{"input":"read both","tools":[{"type":"function","name":"read","parameters":{"type":"object"}}],"tool_choice":"required","parallel_tool_calls":true}`
			if format == sdktranslator.FormatClaude {
				body = `{"messages":[{"role":"user","content":"read both"}],"tools":[{"name":"read","input_schema":{"type":"object"}}],"tool_choice":{"type":"any"}}`
			}
			if format == sdktranslator.FormatOpenAI {
				body = `{"messages":[{"role":"user","content":"read both"}],"tools":[{"type":"function","function":{"name":"read","parameters":{"type":"object"}}}],"tool_choice":"required","parallel_tool_calls":true}`
			}
			native := func(ctx context.Context, _ *cliproxyauth.Auth, r cliproxyexecutor.Request, _ cliproxyexecutor.Options) (*cliproxyexecutor.StreamResult, error) {
				if gjson.GetBytes(r.Payload, "tool_choice").String() != "required" || !gjson.GetBytes(r.Payload, "parallel_tool_calls").Bool() {
					t.Fatalf("required/parallel lost: %s", r.Payload)
				}
				wire := ""
				for _, chunk := range []string{
					`{"id":"f","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"read","arguments":"{\"path\":"}},{"index":1,"id":"call_b","type":"function","function":{"name":"read","arguments":"{\"path\":"}}]}}]}`,
					`{"id":"f","choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"function":{"arguments":"\"b.txt\"}"}},{"index":0,"function":{"arguments":"\"a.txt\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":4,"completion_tokens":6}}`,
				} {
					wire += "data: " + chunk + "\n\n"
				}
				wire += "data: [DONE]\n\n"
				return readAgentChatStream(ctx, &http.Response{Body: io.NopCloser(strings.NewReader(wire)), Header: make(http.Header)}, "fixture"), nil
			}
			req := cliproxyexecutor.Request{Model: "m", Payload: []byte(body)}
			opts := cliproxyexecutor.Options{SourceFormat: format, OriginalRequest: req.Payload}
			result, err := executeAgentResponse(context.Background(), nil, req, opts, native)
			if err != nil {
				t.Fatal(err)
			}
			paths := []string{"output.0.call_id", "output.1.call_id", "output.0.arguments", "output.1.arguments"}
			if format == sdktranslator.FormatClaude {
				paths = []string{"content.0.id", "content.1.id", "content.0.input", "content.1.input"}
			}
			if format == sdktranslator.FormatOpenAI {
				paths = []string{"choices.0.message.tool_calls.0.id", "choices.0.message.tool_calls.1.id", "choices.0.message.tool_calls.0.function.arguments", "choices.0.message.tool_calls.1.function.arguments"}
			}
			for i, want := range []string{"call_a", "call_b", `{"path":"a.txt"}`, `{"path":"b.txt"}`} {
				if got := gjson.GetBytes(result.Payload, paths[i]).String(); got != want {
					t.Errorf("%s=%s want %s", paths[i], got, want)
				}
			}
		})
	}
	t.Run("custom input restored", func(t *testing.T) {
		req := cliproxyexecutor.Request{Model: "m", Payload: []byte(`{"input":"patch","tools":[{"type":"custom","name":"patch"}]}`)}
		native := func(ctx context.Context, _ *cliproxyauth.Auth, r cliproxyexecutor.Request, _ cliproxyexecutor.Options) (*cliproxyexecutor.StreamResult, error) {
			if gjson.GetBytes(r.Payload, "tools.0.function.parameters.properties.input.type").String() != "string" {
				t.Fatal("custom wrapper missing")
			}
			wire := `data: {"id":"f","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_patch","type":"function","function":{"name":"patch","arguments":"{\"input\":\"line1\\nline2\"}"}}]},"finish_reason":"tool_calls"}]}` + "\n\ndata: [DONE]\n\n"
			return readAgentChatStream(ctx, &http.Response{Body: io.NopCloser(strings.NewReader(wire)), Header: make(http.Header)}, "fixture"), nil
		}
		result, err := executeAgentResponse(context.Background(), nil, req, cliproxyexecutor.Options{SourceFormat: sdktranslator.FormatOpenAIResponse}, native)
		if err != nil {
			t.Fatal(err)
		}
		for path, want := range map[string]string{"output.0.type": "custom_tool_call", "output.0.call_id": "call_patch", "output.0.input": "line1\nline2"} {
			if got := gjson.GetBytes(result.Payload, path).String(); got != want {
				t.Errorf("%s=%q want %q", path, got, want)
			}
		}
	})
}
func TestWorkBuddySharedFailedToolResult(t *testing.T) {
	req := cliproxyexecutor.Request{Model: "m", Payload: []byte(`{"messages":[{"role":"assistant","content":[{"type":"tool_use","id":"c","name":"read","input":{}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"c","is_error":true,"content":[{"type":"text","text":"permission denied"}]}]}]}`)}
	canonical, err := agentCanonicalRequest(req, cliproxyexecutor.Options{SourceFormat: sdktranslator.FormatClaude})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(canonical), "is_error=true") || !strings.Contains(string(canonical), "permission denied") {
		t.Fatalf("tool failure lost: %s", canonical)
	}
}

func TestWorkBuddyPartialToolStreamIsNotReplayed(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: "+`{"id":"f","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_write","type":"function","function":{"name":"write","arguments":"{\"path\":"}}]}}]}`+"\n\n")
		if calls == 2 {
			fmt.Fprint(w, "data: "+`{"id":"f","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"a.txt\"}"}}]},"finish_reason":"tool_calls"}]}`+"\n\ndata: [DONE]\n\n")
		}
	}))
	defer server.Close()
	exec := NewWorkBuddyExecutor(&config.Config{})
	auth := &cliproxyauth.Auth{ID: "fixture", Provider: "workbuddy", Attributes: map[string]string{"chat_url": server.URL}, Metadata: map[string]any{"access_token": "synthetic"}}
	req := cliproxyexecutor.Request{Model: "m", Payload: []byte(`{"input":"write","tools":[{"type":"function","name":"write","parameters":{"type":"object"}}]}`)}
	opts := cliproxyexecutor.Options{SourceFormat: sdktranslator.FormatOpenAIResponse}
	for attempt := 1; attempt <= 2; attempt++ {
		stream, err := exec.ExecuteStream(context.Background(), auth, req, opts)
		if err != nil {
			t.Fatal(err)
		}
		failed, completed, done := false, 0, 0
		for chunk := range stream.Chunks {
			if chunk.Err != nil {
				failed = true
			}
			for _, data := range agentResponseData(chunk.Payload) {
				switch gjson.GetBytes(data, "type").String() {
				case "response.completed":
					completed++
				case "response.output_item.done":
					done++
				}
			}
		}
		if calls != attempt {
			t.Fatalf("gateway replayed partial call: %d requests", calls)
		}
		if attempt == 1 && (!failed || completed != 0 || done != 0) {
			t.Fatalf("partial tool was accepted: failed=%v completed=%d tools=%d", failed, completed, done)
		}
		if attempt == 2 && (failed || completed != 1 || done != 1) {
			t.Fatalf("explicit retry failed: failed=%v completed=%d tools=%d", failed, completed, done)
		}
	}
}

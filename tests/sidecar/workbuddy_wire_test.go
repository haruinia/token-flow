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
	for _, mode := range []string{"tool", "empty", "truncated", "json-error"} {
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
				if mode == "tool" {
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

package executor

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/router-for-me/CLIProxyAPI/v7/internal/runtime/executor/helps"
	_ "github.com/router-for-me/CLIProxyAPI/v7/internal/translator"
	cliproxyauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
	cliproxyexecutor "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/executor"
	sdktranslator "github.com/router-for-me/CLIProxyAPI/v7/sdk/translator"
	"github.com/tidwall/gjson"
	"github.com/tidwall/sjson"
)

// Each provider implements one native boundary. Every client format and decision
// fixture exercises the same contract; no provider/client-pair implementation.
func TestAgentContract(t *testing.T) {
	providers := []struct {
		name, model, parameters string
		prepare                 func([]byte, string) ([]byte, error)
	}{
		{"qoder", "kmodel_latest", "parameters.", func(body []byte, model string) ([]byte, error) {
			return helps.BuildQoderRequestBody(body, model, true)
		}},
		{"workbuddy", "glm-5.1", "", helps.PrepareWorkBuddyRequestBody},
	}
	claude := `{"max_tokens":2112,"stop_sequences":["</block>"],"system":[{"type":"text","text":"policy-begin"},{"type":"text","text":"policy-end","cache_control":{"type":"ephemeral"}}],"messages":[{"role":"user","content":[{"type":"text","text":"transcript-begin"},{"type":"text","text":"transcript-end"}]}]}`
	clients := []struct {
		name, payload, responseText string
		format                      sdktranslator.Format
		thinking                    bool
	}{
		{"claude-omitted", claude, "content.0.text", sdktranslator.FormatClaude, false},
		{"claude-disabled", claude, "content.0.text", sdktranslator.FormatClaude, false},
		{"claude-adaptive", claude, "content.0.text", sdktranslator.FormatClaude, true},
		{"claude-enabled", claude, "content.0.text", sdktranslator.FormatClaude, true},
		{"chat", `{"max_completion_tokens":2112,"stop":["</block>"],"reasoning_effort":"none","messages":[{"role":"system","content":"policy-begin\npolicy-end"},{"role":"user","content":"transcript-begin\ntranscript-end"}]}`, "choices.0.message.content", sdktranslator.FormatOpenAI, false},
		{"responses", `{"max_output_tokens":2112,"reasoning":{"effort":"none"},"instructions":"policy-begin\npolicy-end","input":"transcript-begin\ntranscript-end"}`, "output.0.content.0.text", sdktranslator.FormatOpenAIResponse, false},
	}
	for _, provider := range providers {
		for _, client := range clients {
			// Invalid output must also survive verbatim; the gateway cannot turn
			// a malformed decision into permission to execute a tool.
			for _, decision := range []string{"<block>no", "<block>yes", "<block>"} {
				t.Run(provider.name+"/"+client.name+"/"+decision, func(t *testing.T) {
					payload := []byte(client.payload)
					if strings.HasPrefix(client.name, "claude-") && client.name != "claude-omitted" {
						payload, _ = sjson.SetBytes(payload, "thinking.type", strings.TrimPrefix(client.name, "claude-"))
						if client.name == "claude-enabled" {
							payload, _ = sjson.SetBytes(payload, "thinking.budget_tokens", 1024)
						}
					}
					for field, value := range map[string]any{"temperature": 0, "top_p": 0.8, "parallel_tool_calls": false} {
						payload, _ = sjson.SetBytes(payload, field, value)
					}
					req := cliproxyexecutor.Request{Model: provider.model, Payload: payload}
					opts := cliproxyexecutor.Options{SourceFormat: client.format, OriginalRequest: payload}
					native := func(_ context.Context, _ *cliproxyauth.Auth, translated cliproxyexecutor.Request, _ cliproxyexecutor.Options) (*cliproxyexecutor.StreamResult, error) {
						body, err := provider.prepare(translated.Payload, provider.model)
						if err != nil {
							return nil, err
						}
						for field, want := range map[string]string{"max_tokens": "2112", "temperature": "0", "top_p": "0.8"} {
							if got := gjson.GetBytes(body, provider.parameters+field).String(); got != want {
								t.Errorf("native %s = %q, want %q", field, got, want)
							}
						}
						if got := gjson.GetBytes(body, "parallel_tool_calls"); !got.Exists() || got.Bool() {
							t.Error("explicit false parallel_tool_calls was lost")
						}
						if got := gjson.GetBytes(body, provider.parameters+"stop.0"); (client.format != sdktranslator.FormatOpenAIResponse && got.String() != "</block>") || (client.format == sdktranslator.FormatOpenAIResponse && got.Exists()) {
							t.Error("stop sequence was lost or invented")
						}
						thinking := gjson.GetBytes(body, "reasoning_effort").String() != "none"
						if provider.name == "qoder" {
							thinking = gjson.GetBytes(body, "parameters.enable_thinking").Bool()
							if gjson.GetBytes(body, "chat_context.extra.modelConfig.is_reasoning").Bool() != thinking {
								t.Error("inconsistent native thinking flags")
							}
						}
						if thinking != client.thinking {
							t.Errorf("thinking = %v, want %v", thinking, client.thinking)
						}
						var policy, transcript string
						for _, message := range gjson.GetBytes(body, "messages").Array() {
							if message.Get("role").String() == "system" {
								policy += message.Get("content").String()
							} else if message.Get("role").String() == "user" {
								transcript += message.Get("content").String()
							}
						}
						if !strings.Contains(policy, "policy-begin") || !strings.Contains(policy, "policy-end") || !strings.Contains(transcript, "transcript-begin") || !strings.Contains(transcript, "transcript-end") {
							t.Error("policy or transcript was dropped or lost its role")
						}
						chunks := make(chan cliproxyexecutor.StreamChunk, 2)
						chunk, _ := json.Marshal(map[string]any{"id": "approval", "choices": []any{map[string]any{"index": 0, "delta": map[string]string{"role": "assistant", "content": decision}, "finish_reason": "stop"}}})
						chunks <- cliproxyexecutor.StreamChunk{Payload: chunk}
						chunks <- cliproxyexecutor.StreamChunk{Payload: []byte("[DONE]")}
						close(chunks)
						return &cliproxyexecutor.StreamResult{Headers: make(http.Header), Chunks: chunks}, nil
					}
					result, err := executeAgentResponse(context.Background(), nil, req, opts, native)
					if err != nil {
						t.Fatal(err)
					}
					if gjson.GetBytes(result.Payload, client.responseText).String() != decision {
						t.Fatalf("decision was altered: %s", result.Payload)
					}
				})
			}
		}
	}
}

func TestAgentContractUnsupportedTools(t *testing.T) {
	for _, tc := range []struct {
		name, body string
		format     sdktranslator.Format
	}{
		{"responses search", `{"input":"search","tools":[{"type":"web_search"}]}`, sdktranslator.FormatOpenAIResponse},
		{"chat search", `{"messages":[{"role":"user","content":"search"}],"tools":[{"type":"web_search"}]}`, sdktranslator.FormatOpenAI},
		{"claude search", `{"messages":[{"role":"user","content":"search"}],"tools":[{"type":"web_search_20250305","name":"web_search"}]}`, sdktranslator.FormatClaude},
		{"nested unsupported", `{"input":"search","tools":[{"type":"namespace","name":"server","tools":[{"type":"web_search"}]}]}`, sdktranslator.FormatOpenAIResponse},
	} {
		t.Run(tc.name, func(t *testing.T) {
			called := false
			native := func(context.Context, *cliproxyauth.Auth, cliproxyexecutor.Request, cliproxyexecutor.Options) (*cliproxyexecutor.StreamResult, error) {
				called = true
				return nil, statusErr{code: 500, msg: "should not reach transport"}
			}
			req := cliproxyexecutor.Request{Model: "fixture", Payload: []byte(tc.body)}
			_, err := executeAgentResponse(context.Background(), nil, req, cliproxyexecutor.Options{SourceFormat: tc.format}, native)
			if e, ok := err.(statusErr); !ok || e.code != 400 || called {
				t.Fatalf("unsupported tool was not rejected before transport: called=%v err=%v", called, err)
			}
		})
	}
}

func TestAgentContractUnsupportedStructuredOutput(t *testing.T) {
	for format, body := range map[sdktranslator.Format]string{
		sdktranslator.FormatOpenAIResponse: `{"input":"reply","text":{"format":{"type":"json_schema","name":"answer","strict":true,"schema":{"type":"object"}}}}`,
		sdktranslator.FormatOpenAI:         `{"messages":[{"role":"user","content":"reply"}],"response_format":{"type":"json_schema","json_schema":{"name":"answer","strict":true,"schema":{"type":"object"}}}}`,
		sdktranslator.FormatClaude:         `{"messages":[{"role":"user","content":"reply"}],"output_config":{"format":{"type":"json_schema","schema":{"type":"object"}}}}`,
	} {
		t.Run(string(format), func(t *testing.T) {
			called := false
			native := func(context.Context, *cliproxyauth.Auth, cliproxyexecutor.Request, cliproxyexecutor.Options) (*cliproxyexecutor.StreamResult, error) {
				called = true
				return nil, statusErr{code: 500, msg: "should not reach transport"}
			}
			req := cliproxyexecutor.Request{Model: "fixture", Payload: []byte(body)}
			_, err := executeAgentResponse(context.Background(), nil, req, cliproxyexecutor.Options{SourceFormat: format}, native)
			if e, ok := err.(statusErr); !ok || e.code != 400 || called {
				t.Fatalf("unsupported output constraint was not rejected: called=%v err=%v", called, err)
			}
		})
	}
}

// A reasoning model may exhaust its budget before producing visible text.
// That is an incomplete response, not a missing upstream terminal event.
func TestAgentContractReasoningOnlyTruncation(t *testing.T) {
	for _, format := range []sdktranslator.Format{sdktranslator.FormatOpenAIResponse, sdktranslator.FormatClaude, sdktranslator.FormatOpenAI} {
		t.Run(string(format), func(t *testing.T) {
			body := []byte(`{"input":"reply","max_output_tokens":32}`)
			if format != sdktranslator.FormatOpenAIResponse {
				body = []byte(`{"messages":[{"role":"user","content":"reply"}],"max_tokens":32}`)
			}
			native := func(context.Context, *cliproxyauth.Auth, cliproxyexecutor.Request, cliproxyexecutor.Options) (*cliproxyexecutor.StreamResult, error) {
				chunks := make(chan cliproxyexecutor.StreamChunk, 1)
				chunks <- cliproxyexecutor.StreamChunk{Payload: []byte(`{"id":"reasoning-limit","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"reasoning_content":"unfinished reasoning"},"finish_reason":"length"}],"usage":{"prompt_tokens":4,"completion_tokens":32}}`)}
				close(chunks)
				return &cliproxyexecutor.StreamResult{Headers: make(http.Header), Chunks: chunks}, nil
			}
			req := cliproxyexecutor.Request{Model: "fixture", Payload: body}
			result, err := executeAgentResponse(context.Background(), nil, req, cliproxyexecutor.Options{SourceFormat: format}, native)
			if err != nil {
				t.Fatal(err)
			}
			path, want := "status", "incomplete"
			if format == sdktranslator.FormatClaude {
				path, want = "stop_reason", "max_tokens"
			} else if format == sdktranslator.FormatOpenAI {
				path, want = "choices.0.finish_reason", "length"
			}
			if got := gjson.GetBytes(result.Payload, path).String(); got != want {
				t.Fatalf("%s=%q, want %q", path, got, want)
			}
			stream, err := executeAgentResponseStream(context.Background(), nil, req, cliproxyexecutor.Options{SourceFormat: format}, native)
			if err != nil {
				t.Fatal(err)
			}
			terminal := false
			for chunk := range stream.Chunks {
				if chunk.Err != nil {
					t.Fatal(chunk.Err)
				}
				events := agentResponseData(chunk.Payload)
				if format == sdktranslator.FormatOpenAI {
					// Chat chunks are framed as SSE by the HTTP handler.
					events = [][]byte{chunk.Payload}
				}
				for _, event := range events {
					if format == sdktranslator.FormatOpenAIResponse {
						terminal = terminal || gjson.GetBytes(event, "type").String() == "response.incomplete"
					} else if format == sdktranslator.FormatClaude {
						terminal = terminal || gjson.GetBytes(event, "delta.stop_reason").String() == "max_tokens"
					} else {
						terminal = terminal || gjson.GetBytes(event, "choices.0.finish_reason").String() == "length"
					}
				}
			}
			if !terminal {
				t.Fatal("stream lost the output-budget termination")
			}
		})
	}
}

// Clients such as Qoder reconcile deltas and final items by ID. A model may
// alternate reasoning and text within the same choice, so each segment needs
// its own ID and final summary must match exactly the deltas for that ID.
func TestAgentContractInterleavedReasoning(t *testing.T) {
	native := func(context.Context, *cliproxyauth.Auth, cliproxyexecutor.Request, cliproxyexecutor.Options) (*cliproxyexecutor.StreamResult, error) {
		chunks := make(chan cliproxyexecutor.StreamChunk, 5)
		for _, choice := range []string{
			`{"index":0,"delta":{"reasoning_content":"first thought"}}`,
			`{"index":0,"delta":{"content":"first answer"}}`,
			`{"index":0,"delta":{"reasoning_content":"second thought"}}`,
			`{"index":0,"delta":{"content":"second answer"}}`,
			`{"index":0,"delta":{},"finish_reason":"stop"}`,
		} {
			chunks <- cliproxyexecutor.StreamChunk{Payload: []byte(`{"id":"interleaved","object":"chat.completion.chunk","choices":[` + choice + `]}`)}
		}
		close(chunks)
		return &cliproxyexecutor.StreamResult{Headers: make(http.Header), Chunks: chunks}, nil
	}
	stream, err := executeAgentResponseStream(context.Background(), nil, cliproxyexecutor.Request{Model: "fixture", Payload: []byte(`{"input":"reply"}`)}, cliproxyexecutor.Options{SourceFormat: sdktranslator.FormatOpenAIResponse}, native)
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	summaries := map[string]string{}
	finalCount := 0
	for chunk := range stream.Chunks {
		if chunk.Err != nil {
			t.Fatal(chunk.Err)
		}
		for _, payload := range agentResponseData(chunk.Payload) {
			event := gjson.ParseBytes(payload)
			switch event.Get("type").String() {
			case "response.output_item.added":
				id := event.Get("item.id").String()
				if seen[id] {
					t.Errorf("output item ID reused: %s", id)
				}
				seen[id] = true
			case "response.reasoning_summary_text.delta":
				summaries[event.Get("item_id").String()] += event.Get("delta").String()
			case "response.reasoning_summary_text.done":
				if summaries[event.Get("item_id").String()] != event.Get("text").String() {
					t.Error("reasoning done text disagrees with streamed deltas")
				}
			case "response.completed":
				for _, item := range event.Get("response.output").Array() {
					if item.Get("type").String() == "reasoning" {
						finalCount++
						if summaries[item.Get("id").String()] != item.Get("summary.0.text").String() {
							t.Error("final reasoning summary disagrees with streamed deltas")
						}
					}
				}
			}
		}
	}
	if finalCount != 2 {
		t.Fatalf("got %d final reasoning segments, want 2", finalCount)
	}
}

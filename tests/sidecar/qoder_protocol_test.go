package helps

import (
	"testing"

	"github.com/tidwall/gjson"
)

func TestQoderPreservesAgentContext(t *testing.T) {
	body, err := BuildQoderRequestBody([]byte(`{"messages":[{"role":"system","content":"fixture-system"},{"role":"user","content":[{"type":"text","text":"use lookup"}]},{"role":"assistant","content":null,"tool_calls":[{"id":"call_a","type":"function","function":{"name":"lookup","arguments":"{}"}}]},{"role":"tool","tool_call_id":"call_a","content":"fixture-result"}],"tools":[{"type":"function","function":{"name":"lookup","parameters":{"type":"object"}}}],"max_tokens":64}`), "kmodel_latest", true)
	if err != nil {
		t.Fatal(err)
	}
	if gjson.GetBytes(body, "messages.2.content").Type != gjson.String {
		t.Error("Qoder requires text content even on a tool-only assistant message")
	}
	for path, want := range map[string]string{"system": "fixture-system", "messages.0.role": "system", "messages.0.content": "fixture-system", "messages.1.content.0.text": "use lookup", "messages.2.tool_calls.0.id": "call_a", "messages.3.tool_call_id": "call_a", "messages.3.content": "fixture-result", "tools.0.function.name": "lookup", "parameters.max_tokens": "64"} {
		if got := gjson.GetBytes(body, path).String(); got != want {
			t.Errorf("%s = %q, want %q", path, got, want)
		}
	}
}

func TestQoderHonorsDisabledThinking(t *testing.T) {
	for _, effort := range []string{"none", "medium", ""} {
		t.Run(effort, func(t *testing.T) {
			body, err := BuildQoderRequestBody([]byte(`{"messages":[{"role":"user","content":"OK"}],"reasoning_effort":"`+effort+`"}`), "kmodel_latest", true)
			if err != nil {
				t.Fatal(err)
			}
			for _, path := range []string{"parameters.enable_thinking", "chat_context.extra.modelConfig.is_reasoning"} {
				if got := gjson.GetBytes(body, path).Bool(); got != (effort != "none") {
					t.Errorf("%s = %v for effort %q", path, got, effort)
				}
			}
		})
	}
}

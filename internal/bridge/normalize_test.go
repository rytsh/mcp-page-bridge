package bridge

import (
	"encoding/json"
	"testing"
)

// A page can register any JSON as its inputSchema, but MCP requires the root to
// be {"type":"object"}. An agent validates the whole tools/list at once, so a
// single bad schema would take every other provider's tools down with it.
func TestNormalizeObjectSchema(t *testing.T) {
	tests := []struct {
		name        string
		in          string
		want        string
		wantChanged bool
	}{
		{
			name: "valid object schema passes through untouched",
			in:   `{"type":"object","properties":{"a":{"type":"string"}},"required":["a"]}`,
			want: `{"type":"object","properties":{"a":{"type":"string"}},"required":["a"]}`,
		},
		{
			name:        "missing type is filled in, author's fields kept",
			in:          `{"properties":{"a":{"type":"string"}},"required":["a"]}`,
			want:        `{"properties":{"a":{"type":"string"}},"required":["a"],"type":"object"}`,
			wantChanged: true,
		},
		{
			name:        "wrong root type is corrected, fields kept",
			in:          `{"type":"string","properties":{"a":{"type":"number"}}}`,
			want:        `{"properties":{"a":{"type":"number"}},"type":"object"}`,
			wantChanged: true,
		},
		{
			name:        "array root falls back to an open object",
			in:          `[{"type":"object"}]`,
			want:        `{"type":"object","additionalProperties":true}`,
			wantChanged: true,
		},
		{
			name:        "string root falls back",
			in:          `"nonsense"`,
			want:        `{"type":"object","additionalProperties":true}`,
			wantChanged: true,
		},
		{
			name:        "null falls back",
			in:          `null`,
			want:        `{"type":"object","additionalProperties":true}`,
			wantChanged: true,
		},
		{
			name:        "malformed JSON falls back",
			in:          `{oops`,
			want:        `{"type":"object","additionalProperties":true}`,
			wantChanged: true,
		},
		{
			name:        "non-string type falls back to a repaired object",
			in:          `{"type":5}`,
			want:        `{"type":"object"}`,
			wantChanged: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, changed := normalizeObjectSchema(json.RawMessage(tt.in))
			if changed != tt.wantChanged {
				t.Errorf("changed = %v, want %v", changed, tt.wantChanged)
			}
			if !jsonEqual(t, got, json.RawMessage(tt.want)) {
				t.Errorf("normalizeObjectSchema(%s) = %s, want %s", tt.in, got, tt.want)
			}
			// Whatever comes out must satisfy MCP's root constraint.
			assertObjectRoot(t, got)
		})
	}
}

func TestNormalizeToolSchemas(t *testing.T) {
	t.Run("absent inputSchema is synthesized", func(t *testing.T) {
		tool := rawObj{}
		setString(tool, "name", "x")

		repaired, drop := normalizeToolSchemas(tool)
		if drop {
			t.Fatal("tool was dropped")
		}

		if len(repaired) != 1 || repaired[0] != "inputSchema" {
			t.Fatalf("repaired = %v, want [inputSchema]", repaired)
		}
		assertObjectRoot(t, tool["inputSchema"])
	})

	t.Run("valid tool is left alone", func(t *testing.T) {
		tool := rawObj{"inputSchema": json.RawMessage(`{"type":"object"}`)}
		setString(tool, "name", "x")
		if repaired, _ := normalizeToolSchemas(tool); len(repaired) != 0 {
			t.Errorf("repaired = %v, want none", repaired)
		}
	})

	t.Run("unsalvageable outputSchema is dropped, not advertised", func(t *testing.T) {
		tool := rawObj{
			"inputSchema":  json.RawMessage(`{"type":"object"}`),
			"outputSchema": json.RawMessage(`"garbage"`),
		}
		setString(tool, "name", "x")

		repaired, drop := normalizeToolSchemas(tool)
		if drop {
			t.Fatal("tool was dropped")
		}

		if len(repaired) != 1 || repaired[0] != "outputSchema" {
			t.Fatalf("repaired = %v, want [outputSchema]", repaired)
		}
		if _, ok := tool["outputSchema"]; ok {
			t.Errorf("outputSchema should have been dropped, got %s", tool["outputSchema"])
		}
	})

	t.Run("salvageable outputSchema is repaired in place", func(t *testing.T) {
		tool := rawObj{
			"inputSchema":  json.RawMessage(`{"type":"object"}`),
			"outputSchema": json.RawMessage(`{"properties":{"total":{"type":"number"}}}`),
		}
		setString(tool, "name", "x")

		normalizeToolSchemas(tool)

		assertObjectRoot(t, tool["outputSchema"])
		var obj map[string]any
		if err := json.Unmarshal(tool["outputSchema"], &obj); err != nil {
			t.Fatal(err)
		}
		if _, ok := obj["properties"]; !ok {
			t.Error("repair dropped the author's properties")
		}
	})

	t.Run("unknown fields survive the repair", func(t *testing.T) {
		tool := rawObj{
			"inputSchema": json.RawMessage(`{"properties":{}}`),
			"_meta":       json.RawMessage(`{"webmcp/untrustedContentHint":true}`),
		}
		setString(tool, "name", "x")
		setString(tool, "title", "Keep me")

		normalizeToolSchemas(tool)

		if objString(tool, "title") != "Keep me" {
			t.Error("title was lost")
		}
		if string(tool["_meta"]) != `{"webmcp/untrustedContentHint":true}` {
			t.Errorf("_meta was lost or rewritten: %s", tool["_meta"])
		}
	})
}

func assertObjectRoot(t *testing.T, raw json.RawMessage) {
	t.Helper()
	var probe struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(raw, &probe); err != nil {
		t.Fatalf("schema is not a JSON object: %s (%v)", raw, err)
	}
	if probe.Type != "object" {
		t.Fatalf(`schema root type = %q, want "object": %s`, probe.Type, raw)
	}
}

func jsonEqual(t *testing.T, a, b json.RawMessage) bool {
	t.Helper()
	var av, bv any
	if err := json.Unmarshal(a, &av); err != nil {
		return false
	}
	if err := json.Unmarshal(b, &bv); err != nil {
		t.Fatalf("bad expectation JSON: %s", b)
	}
	ab, _ := json.Marshal(av)
	bb, _ := json.Marshal(bv)
	return string(ab) == string(bb)
}

// MCP also constrains inputSchema.properties (object of objects) and
// inputSchema.required ([]string). Getting only the root `type` right still
// rejects the merged catalog.
func TestNormalizeObjectSchemaInnerFields(t *testing.T) {
	tests := []struct {
		name        string
		in          string
		want        string
		wantChanged bool
	}{
		{
			name:        "required given as a bare string is promoted to a list",
			in:          `{"type":"object","required":"name"}`,
			want:        `{"type":"object","required":["name"]}`,
			wantChanged: true,
		},
		{
			name:        "required given as a number list is dropped",
			in:          `{"type":"object","required":[1,2]}`,
			want:        `{"type":"object"}`,
			wantChanged: true,
		},
		{
			name:        "properties as an array is dropped",
			in:          `{"type":"object","properties":[]}`,
			want:        `{"type":"object"}`,
			wantChanged: true,
		},
		{
			name:        "non-object property entries are dropped, good ones kept",
			in:          `{"type":"object","properties":{"a":{"type":"string"},"b":"nope"}}`,
			want:        `{"type":"object","properties":{"a":{"type":"string"}}}`,
			wantChanged: true,
		},
		{
			name: "a fully valid schema is untouched",
			in:   `{"type":"object","properties":{"a":{"type":"string"}},"required":["a"]}`,
			want: `{"type":"object","properties":{"a":{"type":"string"}},"required":["a"]}`,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, changed := normalizeObjectSchema(json.RawMessage(tt.in))
			if changed != tt.wantChanged {
				t.Errorf("changed = %v, want %v", changed, tt.wantChanged)
			}
			if !jsonEqual(t, got, json.RawMessage(tt.want)) {
				t.Errorf("got %s, want %s", got, tt.want)
			}
		})
	}
}

func TestNormalizePrompt(t *testing.T) {
	t.Run("a prompt without a usable name is dropped", func(t *testing.T) {
		for _, in := range []rawObj{
			{},
			{"name": json.RawMessage(`""`)},
			{"name": json.RawMessage(`42`)},
		} {
			if _, drop := normalizePrompt(cloneObj(in)); !drop {
				t.Errorf("normalizePrompt(%v) should drop", in)
			}
		}
	})

	t.Run("arguments given as an object is dropped", func(t *testing.T) {
		prompt := rawObj{"arguments": json.RawMessage(`{"a":1}`)}
		setString(prompt, "name", "p")

		repaired, drop := normalizePrompt(prompt)

		if drop {
			t.Fatal("prompt should survive")
		}
		if len(repaired) != 1 || repaired[0] != "arguments" {
			t.Fatalf("repaired = %v", repaired)
		}
		if _, ok := prompt["arguments"]; ok {
			t.Error("arguments should have been dropped")
		}
	})

	t.Run("argument entries without a name are dropped, valid ones kept", func(t *testing.T) {
		prompt := rawObj{
			"arguments": json.RawMessage(`[{"name":"ok","required":true},{"description":"no name"},{"name":7}]`),
		}
		setString(prompt, "name", "p")

		normalizePrompt(prompt)

		var args []map[string]any
		if err := json.Unmarshal(prompt["arguments"], &args); err != nil {
			t.Fatal(err)
		}
		if len(args) != 1 || args[0]["name"] != "ok" || args[0]["required"] != true {
			t.Errorf("arguments = %v, want just the valid entry", args)
		}
	})

	t.Run("non-boolean required on an argument is dropped", func(t *testing.T) {
		prompt := rawObj{"arguments": json.RawMessage(`[{"name":"a","required":"yes"}]`)}
		setString(prompt, "name", "p")

		normalizePrompt(prompt)

		var args []map[string]any
		if err := json.Unmarshal(prompt["arguments"], &args); err != nil {
			t.Fatal(err)
		}
		if _, ok := args[0]["required"]; ok {
			t.Errorf("required should have been dropped: %v", args[0])
		}
	})

	t.Run("a valid prompt is untouched", func(t *testing.T) {
		prompt := rawObj{"arguments": json.RawMessage(`[{"name":"a","required":true}]`)}
		setString(prompt, "name", "p")
		setString(prompt, "description", "d")

		if repaired, drop := normalizePrompt(prompt); drop || len(repaired) != 0 {
			t.Errorf("repaired = %v drop = %v, want none", repaired, drop)
		}
	})
}

func TestNormalizeResource(t *testing.T) {
	t.Run("a resource without a uri is dropped — it is also unroutable", func(t *testing.T) {
		for _, in := range []rawObj{
			{},
			{"uri": json.RawMessage(`""`)},
			{"uri": json.RawMessage(`{"a":1}`)},
		} {
			if _, drop := normalizeResource(cloneObj(in)); !drop {
				t.Errorf("normalizeResource(%v) should drop", in)
			}
		}
	})

	t.Run("a non-numeric size is dropped", func(t *testing.T) {
		res := rawObj{"size": json.RawMessage(`"big"`)}
		setString(res, "uri", "app://x")
		setString(res, "name", "r")

		repaired, drop := normalizeResource(res)

		if drop {
			t.Fatal("resource should survive")
		}
		if len(repaired) != 1 || repaired[0] != "size" {
			t.Fatalf("repaired = %v", repaired)
		}
		if _, ok := res["size"]; ok {
			t.Error("size should have been dropped")
		}
	})

	t.Run("non-string mimeType is dropped", func(t *testing.T) {
		res := rawObj{"mimeType": json.RawMessage(`123`)}
		setString(res, "uri", "app://x")

		normalizeResource(res)

		if _, ok := res["mimeType"]; ok {
			t.Error("mimeType should have been dropped")
		}
	})

	t.Run("a valid resource is untouched", func(t *testing.T) {
		res := rawObj{"size": json.RawMessage(`120`)}
		setString(res, "uri", "app://x")
		setString(res, "name", "r")
		setString(res, "mimeType", "text/plain")

		if repaired, drop := normalizeResource(res); drop || len(repaired) != 0 {
			t.Errorf("repaired = %v drop = %v, want none", repaired, drop)
		}
	})
}

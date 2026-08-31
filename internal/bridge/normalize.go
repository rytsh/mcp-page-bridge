package bridge

import (
	"encoding/json"
)

// Catalog normalization.
//
// The bridge merges every provider in a partition into ONE tools/list,
// prompts/list and resources/list. An MCP client validates each response as a
// whole, so a single page shipping a malformed entry rejects the entire
// response — taking every other tab's catalog down with it. Providers are
// untrusted page code, so the bridge repairs what it can and drops what it
// cannot, rather than forwarding it verbatim.
//
// The constraints enforced here mirror ToolSchema / PromptSchema /
// ResourceSchema in @modelcontextprotocol/sdk. Unknown fields are deliberately
// left untouched: MCP allows them and clients pass them through.

// openObjectSchema is the permissive fallback used when a schema cannot be
// salvaged.
var openObjectSchema = json.RawMessage(`{"type":"object","additionalProperties":true}`)

// jsonKind reports the JSON type of raw without fully decoding it.
func jsonKind(raw json.RawMessage) byte {
	for _, c := range raw {
		switch c {
		case ' ', '\t', '\n', '\r':
			continue
		default:
			return c
		}
	}
	return 0
}

func isJSONObject(raw json.RawMessage) bool { return jsonKind(raw) == '{' }
func isJSONArray(raw json.RawMessage) bool  { return jsonKind(raw) == '[' }
func isJSONString(raw json.RawMessage) bool { return jsonKind(raw) == '"' }

// isJSONNumber reports whether raw is a JSON number (MCP's `size` etc.).
func isJSONNumber(raw json.RawMessage) bool {
	k := jsonKind(raw)
	return k == '-' || (k >= '0' && k <= '9')
}

// dropNonStringFields removes optional fields that MCP types as strings but the
// provider sent as something else. Returns the names it removed.
func dropNonStringFields(o rawObj, keys ...string) []string {
	var dropped []string
	for _, key := range keys {
		raw, ok := o[key]
		if !ok {
			continue
		}
		if !isJSONString(raw) {
			delete(o, key)
			dropped = append(dropped, key)
		}
	}
	return dropped
}

// normalizeObjectSchema coerces a tool schema into something MCP accepts.
//
// MCP requires the ROOT to be `{"type":"object"}`, `properties` to be an object
// whose values are objects, and `required` to be an array of strings. Anything
// else rejects the whole catalog.
//
// Returns the schema to advertise and whether it had to be rewritten.
func normalizeObjectSchema(raw json.RawMessage) (json.RawMessage, bool) {
	var obj rawObj
	if err := json.Unmarshal(raw, &obj); err != nil || obj == nil {
		// Not a JSON object at all (array, string, number, null, malformed).
		return openObjectSchema, true
	}

	changed := false

	// Root type. Keep the author's properties/required when we can — a missing
	// or wrong `type` is a common hand-written mistake, not a reason to discard
	// the schema.
	var kind string
	if err := json.Unmarshal(obj["type"], &kind); err != nil || kind != "object" {
		obj["type"] = json.RawMessage(`"object"`)
		changed = true
	}

	if props, ok := obj["properties"]; ok {
		if fixed, propsChanged := normalizeSchemaProperties(props); propsChanged {
			if fixed == nil {
				delete(obj, "properties")
			} else {
				obj["properties"] = fixed
			}
			changed = true
		}
	}

	if req, ok := obj["required"]; ok {
		if fixed, reqChanged := normalizeRequiredList(req); reqChanged {
			if fixed == nil {
				delete(obj, "required")
			} else {
				obj["required"] = fixed
			}
			changed = true
		}
	}

	if !changed {
		return raw, false
	}
	fixed, err := json.Marshal(obj)
	if err != nil {
		return openObjectSchema, true
	}
	return fixed, true
}

// normalizeSchemaProperties enforces "object whose values are objects". Returns
// (nil, true) when the whole field must be dropped.
func normalizeSchemaProperties(raw json.RawMessage) (json.RawMessage, bool) {
	var props rawObj
	if err := json.Unmarshal(raw, &props); err != nil || props == nil {
		return nil, true
	}
	changed := false
	for name, value := range props {
		if !isJSONObject(value) {
			delete(props, name)
			changed = true
		}
	}
	if !changed {
		return raw, false
	}
	fixed, err := json.Marshal(props)
	if err != nil {
		return nil, true
	}
	return fixed, true
}

// normalizeRequiredList enforces []string. A bare string — a common mistake —
// is promoted to a single-element list rather than dropped.
func normalizeRequiredList(raw json.RawMessage) (json.RawMessage, bool) {
	var names []string
	if err := json.Unmarshal(raw, &names); err == nil {
		return raw, false
	}
	if isJSONString(raw) {
		fixed, err := json.Marshal([]json.RawMessage{raw})
		if err == nil {
			return fixed, true
		}
	}
	return nil, true
}

// normalizeToolSchemas rewrites a cloned tool in place so it satisfies MCP.
// Returns the fields it repaired, and whether the tool must be dropped entirely.
func normalizeToolSchemas(clone rawObj) (repaired []string, drop bool) {
	// `name` is how the bridge routes the call; an unnamed tool is unusable.
	if raw, ok := clone["name"]; !ok || !isJSONString(raw) || objString(clone, "name") == "" {
		return nil, true
	}

	repaired = append(repaired, dropNonStringFields(clone, "title", "description")...)

	// inputSchema is REQUIRED by MCP; synthesize an open one when absent.
	if raw, ok := clone["inputSchema"]; !ok || len(raw) == 0 {
		clone["inputSchema"] = openObjectSchema
		repaired = append(repaired, "inputSchema")
	} else if fixed, changed := normalizeObjectSchema(raw); changed {
		clone["inputSchema"] = fixed
		repaired = append(repaired, "inputSchema")
	}

	// outputSchema is optional; drop it rather than advertise an invalid one.
	if raw, ok := clone["outputSchema"]; ok {
		if fixed, changed := normalizeObjectSchema(raw); changed {
			if string(fixed) == string(openObjectSchema) {
				delete(clone, "outputSchema")
			} else {
				clone["outputSchema"] = fixed
			}
			repaired = append(repaired, "outputSchema")
		}
	}

	return repaired, false
}

// normalizePrompt rewrites a cloned prompt in place. MCP requires a string
// `name` and, when present, `arguments` to be an array of objects that each
// carry a string `name`.
func normalizePrompt(clone rawObj) (repaired []string, drop bool) {
	if raw, ok := clone["name"]; !ok || !isJSONString(raw) || objString(clone, "name") == "" {
		return nil, true
	}

	repaired = append(repaired, dropNonStringFields(clone, "title", "description")...)

	raw, ok := clone["arguments"]
	if !ok {
		return repaired, false
	}
	if !isJSONArray(raw) {
		delete(clone, "arguments")
		return append(repaired, "arguments"), false
	}

	var items []json.RawMessage
	if err := json.Unmarshal(raw, &items); err != nil {
		delete(clone, "arguments")
		return append(repaired, "arguments"), false
	}

	kept := make([]json.RawMessage, 0, len(items))
	changed := false
	for _, item := range items {
		var arg rawObj
		if err := json.Unmarshal(item, &arg); err != nil || arg == nil {
			changed = true
			continue
		}
		if nameRaw, ok := arg["name"]; !ok || !isJSONString(nameRaw) {
			changed = true
			continue
		}
		argChanged := len(dropNonStringFields(arg, "title", "description")) > 0
		if req, ok := arg["required"]; ok && string(req) != "true" && string(req) != "false" {
			delete(arg, "required")
			argChanged = true
		}
		if !argChanged {
			kept = append(kept, item)
			continue
		}
		fixed, err := json.Marshal(arg)
		if err != nil {
			changed = true
			continue
		}
		kept = append(kept, fixed)
		changed = true
	}

	if !changed {
		return repaired, false
	}
	fixed, err := json.Marshal(kept)
	if err != nil {
		delete(clone, "arguments")
	} else {
		clone["arguments"] = fixed
	}
	return append(repaired, "arguments"), false
}

// normalizeResource rewrites a cloned resource in place. `uri` is both an MCP
// requirement and the bridge's routing key, so a resource without one is
// dropped instead of repaired.
func normalizeResource(clone rawObj) (repaired []string, drop bool) {
	if raw, ok := clone["uri"]; !ok || !isJSONString(raw) || objString(clone, "uri") == "" {
		return nil, true
	}

	repaired = append(repaired, dropNonStringFields(clone, "name", "title", "description", "mimeType")...)

	if size, ok := clone["size"]; ok && !isJSONNumber(size) {
		delete(clone, "size")
		repaired = append(repaired, "size")
	}

	return repaired, false
}

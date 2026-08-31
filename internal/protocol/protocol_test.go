package protocol

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestSanitizeLabel(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{"empty falls back", "", "browser"},
		{"plain name", "demo", "demo"},
		{"uppercase lowered", "MyApp", "myapp"},
		{"spaces and dots to hyphen", "my cool.app", "my-cool-app"},
		{"disallowed stripped", "app!@#name", "appname"},
		{"hyphen runs collapsed", "a -- b", "a-b"},
		{"edges trimmed", "--app__", "app"},
		{"only junk falls back", "!!!", "browser"},
		{"clamped to 40", "aaaaaaaaaabbbbbbbbbbccccccccccddddddddddX", "aaaaaaaaaabbbbbbbbbbccccccccccdddddddddd"},
		{"unicode stripped", "uygulama-ç-ö", "uygulama"}, // ç/ö removed, runs collapsed, edges trimmed
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := SanitizeLabel(tt.input); got != tt.want {
				t.Errorf("SanitizeLabel(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

func TestNamespaceName(t *testing.T) {
	if got := NamespaceName("page", "eval"); got != "page__eval" {
		t.Errorf("NamespaceName() = %q", got)
	}
}

func TestNamespaceNameClamps(t *testing.T) {
	// Exactly at the limit: untouched.
	atLimit := NamespaceName("page", strings.Repeat("a", MaxToolNameLen-len("page__")))
	if len(atLimit) != MaxToolNameLen || strings.Contains(atLimit, "-") {
		t.Errorf("name at the limit was rewritten: %q (len %d)", atLimit, len(atLimit))
	}

	// One over: clamped to exactly MaxToolNameLen.
	long := strings.Repeat("a", 200)
	got := NamespaceName("page", long)
	if len(got) != MaxToolNameLen {
		t.Fatalf("NamespaceName() len = %d, want %d (%q)", len(got), MaxToolNameLen, got)
	}
	if !strings.HasPrefix(got, "page__") {
		t.Errorf("clamped name lost its label prefix: %q", got)
	}

	// Deterministic: the agent must see the same name after a reconnect.
	if again := NamespaceName("page", long); again != got {
		t.Errorf("NamespaceName() not deterministic: %q vs %q", got, again)
	}

	// Names sharing a long prefix must not collapse onto one.
	a := NamespaceName("page", long+"-alpha")
	b := NamespaceName("page", long+"-beta")
	if a == b {
		t.Errorf("distinct long names collided: %q", a)
	}
}

// TestNamespaceNameGoldenVectors pins the exact output so the TypeScript twin
// (packages/protocol, exercised by protocol-namespace.test.ts) cannot drift.
// The bridge builds its routing table with this function and advertises the
// same names, so a mismatch between the two languages makes tools unroutable.
func TestNamespaceNameGoldenVectors(t *testing.T) {
	tests := []struct{ label, name, want string }{
		{"page", "eval", "page__eval"},
		{"page", strings.Repeat("a", 200), "page__aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-324a88"},
		{"checkout", strings.Repeat("a", 200) + "-alpha", "checkout__aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-974d86"},
		{"checkout", strings.Repeat("a", 200) + "-beta", "checkout__aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-24e0f3"},
		{"page", strings.Repeat("ö", 100), "page__ööööööööööööööööööööööööö-031816"},
		{"a-very-long-label-that-is-forty-chars-ok", strings.Repeat("x", 60), "a-very-long-label-that-is-forty-chars-ok__xxxxxxxxxxxxxxx-e3a151"},
	}
	for _, tt := range tests {
		if got := NamespaceName(tt.label, tt.name); got != tt.want {
			t.Errorf("NamespaceName(%q, %.20q…) = %q, want %q", tt.label, tt.name, got, tt.want)
		}
	}
}

func TestNamespaceNameKeepsValidUTF8(t *testing.T) {
	// A non-extension provider can send a non-ASCII tool name; the byte-level
	// cut must not split a rune.
	got := NamespaceName("page", strings.Repeat("ö", 100))
	if !utf8.ValidString(got) {
		t.Errorf("NamespaceName() produced invalid UTF-8: %q", got)
	}
	if len(got) > MaxToolNameLen {
		t.Errorf("NamespaceName() len = %d, want <= %d", len(got), MaxToolNameLen)
	}
}

func TestHashProfile(t *testing.T) {
	// Empty secret → empty key (the default, unpartitioned bridge).
	if got := HashProfile(""); got != "" {
		t.Errorf("HashProfile(\"\") = %q, want empty", got)
	}
	// Stable, domain-separated SHA-256 vector. The extension's hashProfile()
	// and `mcp-page-bridge profile-hash mysecret` must produce the same value.
	const want = "825d9eb0b5484e0a22a70ec854790e2d8daaa9171edd03b0bfbc98e276f20e94"
	if got := HashProfile("mysecret"); got != want {
		t.Errorf("HashProfile(\"mysecret\") = %q, want %q", got, want)
	}
	// Different secrets yield different keys; the plaintext never appears.
	if HashProfile("a") == HashProfile("b") {
		t.Error("distinct secrets must hash to distinct keys")
	}
	if got := HashProfile("mysecret"); strings.Contains(got, "mysecret") {
		t.Errorf("hash must not contain the plaintext: %q", got)
	}
}

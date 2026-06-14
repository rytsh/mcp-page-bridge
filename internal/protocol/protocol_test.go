package protocol

import (
	"strings"
	"testing"
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

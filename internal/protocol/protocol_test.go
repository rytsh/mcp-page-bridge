package protocol

import "testing"

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

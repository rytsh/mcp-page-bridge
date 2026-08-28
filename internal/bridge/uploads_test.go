package bridge

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/rytsh/mcp-page-bridge/internal/mcpwire"
)

// The upload directory is the only thing standing between a bridged page and
// the user's filesystem, so its containment rules get direct coverage.
func TestResolveUploadPath(t *testing.T) {
	root := t.TempDir()
	real, err := filepath.EvalSymlinks(root)
	if err != nil {
		t.Fatalf("eval symlinks: %v", err)
	}

	inside := filepath.Join(real, "fixture.txt")
	if err := os.WriteFile(inside, []byte("hello"), 0o600); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	nested := filepath.Join(real, "sub")
	if err := os.Mkdir(nested, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	nestedFile := filepath.Join(nested, "deep.txt")
	if err := os.WriteFile(nestedFile, []byte("deep"), 0o600); err != nil {
		t.Fatalf("write nested: %v", err)
	}

	outsideDir := t.TempDir()
	outside := filepath.Join(outsideDir, "secret.txt")
	if err := os.WriteFile(outside, []byte("nope"), 0o600); err != nil {
		t.Fatalf("write outside: %v", err)
	}

	t.Run("absolute path inside the root", func(t *testing.T) {
		got, err := resolveUploadPath(real, inside)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got != inside {
			t.Fatalf("got %q, want %q", got, inside)
		}
	})

	t.Run("relative path is joined onto the root", func(t *testing.T) {
		got, err := resolveUploadPath(real, "sub/deep.txt")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got != nestedFile {
			t.Fatalf("got %q, want %q", got, nestedFile)
		}
	})

	t.Run("absolute path outside the root is refused", func(t *testing.T) {
		if _, err := resolveUploadPath(real, outside); err == nil {
			t.Fatal("expected an error for a path outside the upload dir")
		}
	})

	t.Run("traversal out of the root is refused", func(t *testing.T) {
		if _, err := resolveUploadPath(real, "../"+filepath.Base(outsideDir)+"/secret.txt"); err == nil {
			t.Fatal("expected an error for a traversing path")
		}
	})

	t.Run("symlink escaping the root is refused", func(t *testing.T) {
		if runtime.GOOS == "windows" {
			t.Skip("symlinks need elevation on Windows")
		}
		link := filepath.Join(real, "escape.txt")
		if err := os.Symlink(outside, link); err != nil {
			t.Skipf("symlink unsupported: %v", err)
		}
		// The link itself lives inside the root; only resolving it first reveals
		// that the file it points at does not.
		if _, err := resolveUploadPath(real, link); err == nil {
			t.Fatal("expected an error for a symlink pointing outside the upload dir")
		}
	})
}

func TestReadUploadFileDisabledByDefault(t *testing.T) {
	b := New(Options{})
	_, rpcErr := b.readUploadFile(json.RawMessage(`{"path":"/etc/passwd"}`))
	if rpcErr == nil {
		t.Fatal("expected readFile to be refused without --upload-dir")
	}
	if rpcErr.Code != mcpwire.CodeInvalidRequest {
		t.Fatalf("got code %d, want %d", rpcErr.Code, mcpwire.CodeInvalidRequest)
	}
	if !strings.Contains(rpcErr.Message, "--upload-dir") {
		t.Fatalf("error should point at --upload-dir, got %q", rpcErr.Message)
	}
}

func TestReadUploadFileServesFilesInsideTheRoot(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatalf("eval symlinks: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "note.txt"), []byte("hi"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	b := New(Options{UploadDir: root})
	raw, rpcErr := b.readUploadFile(json.RawMessage(`{"path":"note.txt"}`))
	if rpcErr != nil {
		t.Fatalf("unexpected error: %v", rpcErr)
	}
	var got struct {
		Name     string `json:"name"`
		MimeType string `json:"mimeType"`
		Size     int    `json:"size"`
		Base64   string `json:"base64"`
	}
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.Name != "note.txt" || got.Size != 2 || got.Base64 != "aGk=" {
		t.Fatalf("unexpected result: %+v", got)
	}

	if _, rpcErr := b.readUploadFile(json.RawMessage(`{"path":"missing.txt"}`)); rpcErr == nil {
		t.Fatal("expected an error for a missing file")
	}
	if _, rpcErr := b.readUploadFile(json.RawMessage(`{}`)); rpcErr == nil {
		t.Fatal("expected an error for a missing path")
	}
}

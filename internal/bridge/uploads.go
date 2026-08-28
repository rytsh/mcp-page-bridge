package bridge

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"mime"
	"os"
	"path/filepath"
	"strings"

	"github.com/rytsh/mcp-page-bridge/internal/mcpwire"
	"github.com/rytsh/mcp-page-bridge/internal/protocol"
)

// readUploadFile answers `mcpPageBridge/readFile`, the bridge side of
// `upload_file { path }`.
//
// A browser extension has no filesystem access, so attaching a real file to an
// <input type=file> needs someone on this machine to read the bytes. That is a
// genuine privilege escalation — any page on a bridged tab can reach this
// method — so the daemon is the single enforcement point:
//
//   - refused entirely unless the operator passed --upload-dir,
//   - the resolved path (symlinks followed) must stay inside that directory,
//   - regular files only, capped at MaxUploadFileBytes.
//
// Point --upload-dir at a dedicated directory. In particular do not point it at
// the browser's download directory, or every file a page can make the browser
// download becomes a file it can make the browser upload somewhere else.
func (b *Bridge) readUploadFile(params json.RawMessage) (json.RawMessage, *mcpwire.RPCError) {
	if b.opts.UploadDir == "" {
		return nil, &mcpwire.RPCError{
			Code:    mcpwire.CodeInvalidRequest,
			Message: "file uploads by path are disabled; start the bridge with --upload-dir <dir> and put the file there",
		}
	}

	var req struct {
		Path string `json:"path"`
	}
	if err := json.Unmarshal(params, &req); err != nil || strings.TrimSpace(req.Path) == "" {
		return nil, &mcpwire.RPCError{Code: mcpwire.CodeInvalidParams, Message: "readFile needs a path"}
	}

	path, err := resolveUploadPath(b.opts.UploadDir, req.Path)
	if err != nil {
		return nil, &mcpwire.RPCError{Code: mcpwire.CodeInvalidParams, Message: err.Error()}
	}

	info, err := os.Stat(path)
	if err != nil {
		return nil, &mcpwire.RPCError{Code: mcpwire.CodeInvalidParams, Message: fmt.Sprintf("read %s; %v", req.Path, err)}
	}
	if !info.Mode().IsRegular() {
		return nil, &mcpwire.RPCError{Code: mcpwire.CodeInvalidParams, Message: fmt.Sprintf("%s is not a regular file", req.Path)}
	}
	if info.Size() > protocol.MaxUploadFileBytes {
		return nil, &mcpwire.RPCError{
			Code:    mcpwire.CodeInvalidParams,
			Message: fmt.Sprintf("%s is %d bytes; the limit is %d", req.Path, info.Size(), protocol.MaxUploadFileBytes),
		}
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return nil, &mcpwire.RPCError{Code: mcpwire.CodeInternalError, Message: fmt.Sprintf("read %s; %v", req.Path, err)}
	}

	name := filepath.Base(path)
	mimeType := mime.TypeByExtension(filepath.Ext(name))
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}

	return marshalResult(map[string]any{
		"name":     name,
		"mimeType": mimeType,
		"size":     len(data),
		"base64":   base64.StdEncoding.EncodeToString(data),
	})
}

// resolveUploadPath maps a requested path onto a real file inside root.
// Relative paths are taken relative to root; absolute ones must already be
// inside it. Symlinks are resolved first, so a link placed inside root cannot
// be used to read something outside it.
func resolveUploadPath(root, requested string) (string, error) {
	candidate := requested
	if !filepath.IsAbs(candidate) {
		candidate = filepath.Join(root, candidate)
	}

	resolved, err := filepath.EvalSymlinks(candidate)
	if err != nil {
		return "", fmt.Errorf("resolve %s; %w", requested, err)
	}

	rel, err := filepath.Rel(root, resolved)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("%s is outside the configured --upload-dir", requested)
	}
	return resolved, nil
}

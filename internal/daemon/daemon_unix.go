//go:build !windows

package daemon

import (
	"syscall"
)

// detachedProcAttr detaches the daemon from the agent's process group so it
// survives the proxy exiting.
func detachedProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setsid: true}
}

func terminateProcess(pid int) error {
	return syscall.Kill(pid, syscall.SIGTERM)
}

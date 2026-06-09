package bridge

import (
	"fmt"

	"github.com/rytsh/mcp-page-bridge/internal/protocol"
)

const maxLabelReservations = 1000

// labelStore remembers which namespace label a given page/tab/provider was
// assigned so reconnects keep their namespace. Insertion order doubles as
// recency for LRU eviction (refreshed entries move to the back).
type labelStore struct {
	values map[string]string
	order  []string
}

func newLabelStore() *labelStore {
	return &labelStore{values: map[string]string{}}
}

func (s *labelStore) get(key string) (string, bool) {
	v, ok := s.values[key]
	return v, ok
}

// touch sets/refreshes a reservation, moving the key to most-recent.
func (s *labelStore) touch(key, label string) {
	if _, ok := s.values[key]; ok {
		s.remove(key)
	}
	s.values[key] = label
	s.order = append(s.order, key)
}

func (s *labelStore) remove(key string) {
	delete(s.values, key)
	for i, k := range s.order {
		if k == key {
			s.order = append(s.order[:i], s.order[i+1:]...)
			break
		}
	}
}

func (s *labelStore) len() int { return len(s.values) }

// prune bounds the store; labels currently in use are never evicted.
func (s *labelStore) prune(inUse map[string]bool) {
	if len(s.values) <= maxLabelReservations {
		return
	}
	for _, key := range append([]string(nil), s.order...) {
		if len(s.values) <= maxLabelReservations {
			break
		}
		if inUse[s.values[key]] {
			continue
		}
		s.remove(key)
	}
}

type reservationKeys struct {
	exact    []string
	fallback []string
}

func keysFor(base string, meta Meta) reservationKeys {
	var keys reservationKeys
	switch {
	case meta.TabID != nil && meta.ProviderID != "":
		keys.exact = append(keys.exact, fmt.Sprintf("tab:%d:provider:%s:name:%s", *meta.TabID, meta.ProviderID, base))
	case meta.ProviderID != "":
		keys.exact = append(keys.exact, fmt.Sprintf("provider:%s:name:%s", meta.ProviderID, base))
	}
	if meta.TabID != nil {
		keys.fallback = append(keys.fallback, fmt.Sprintf("tab:%d:name:%s", *meta.TabID, base))
	}
	if meta.URL != "" {
		keys.fallback = append(keys.fallback, fmt.Sprintf("url:%s:name:%s", meta.URL, base))
	}
	return keys
}

func uniqueLabel(base string, used map[string]bool) string {
	if !used[base] {
		return base
	}
	for i := 2; ; i++ {
		candidate := fmt.Sprintf("%s-%d", base, i)
		if !used[candidate] {
			return candidate
		}
	}
}

// assignLabel must be called with Bridge.mu held.
func (b *Bridge) assignLabel(rawName string, meta Meta) string {
	base := protocol.SanitizeLabel(rawName)
	keys := keysFor(base, meta)
	used := b.labelsInUse()

	for _, key := range append(append([]string(nil), keys.exact...), keys.fallback...) {
		if reserved, ok := b.labels.get(key); ok && !used[reserved] {
			b.rememberLabel(keys, reserved)
			return reserved
		}
	}

	label := uniqueLabel(base, used)
	b.rememberLabel(keys, label)
	return label
}

func (b *Bridge) rememberLabel(keys reservationKeys, label string) {
	for _, key := range keys.exact {
		b.labels.touch(key, label)
	}
	for _, key := range keys.fallback {
		if existing, ok := b.labels.get(key); ok {
			b.labels.touch(key, existing)
		} else {
			b.labels.touch(key, label)
		}
	}
	b.labels.prune(b.labelsInUse())
}

func (b *Bridge) labelsInUse() map[string]bool {
	used := make(map[string]bool, len(b.providers))
	for _, p := range b.providers {
		used[p.label] = true
	}
	return used
}

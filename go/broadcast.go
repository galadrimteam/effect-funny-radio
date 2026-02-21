package main

import "sync"

// Broadcaster is a fan-out pub/sub for BroadcastMessage.
// It replaces Effect's PubSub, allowing multiple SSE clients to subscribe.
type Broadcaster struct {
	mu          sync.RWMutex
	subscribers map[uint64]chan BroadcastMessage
	nextID      uint64
	closed      bool
}

func NewBroadcaster() *Broadcaster {
	return &Broadcaster{
		subscribers: make(map[uint64]chan BroadcastMessage),
	}
}

// Subscribe returns a channel that receives broadcast messages and an
// unsubscribe function. The channel is buffered to avoid blocking the
// publisher.
func (b *Broadcaster) Subscribe() (<-chan BroadcastMessage, func()) {
	b.mu.Lock()
	defer b.mu.Unlock()

	ch := make(chan BroadcastMessage, 64)
	id := b.nextID
	b.nextID++
	b.subscribers[id] = ch

	unsub := func() {
		b.mu.Lock()
		defer b.mu.Unlock()
		if _, ok := b.subscribers[id]; ok {
			delete(b.subscribers, id)
			close(ch)
		}
	}
	return ch, unsub
}

// Publish sends a message to all subscribers. Non-blocking: if a subscriber's
// buffer is full the message is dropped for that subscriber.
func (b *Broadcaster) Publish(msg BroadcastMessage) {
	b.mu.RLock()
	defer b.mu.RUnlock()

	for _, ch := range b.subscribers {
		select {
		case ch <- msg:
		default:
			// subscriber buffer full, drop message
		}
	}
}

// Close shuts down the broadcaster and closes all subscriber channels.
func (b *Broadcaster) Close() {
	b.mu.Lock()
	defer b.mu.Unlock()

	if b.closed {
		return
	}
	b.closed = true
	for id, ch := range b.subscribers {
		delete(b.subscribers, id)
		close(ch)
	}
}

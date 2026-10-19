---
'@leaven-graphql/ws': patch
---

Bound `onConnect` by `connectionInitTimeout`. The handler stopped its init timer when `connection_init` arrived, so an `onConnect` that never settled kept the socket open, unacknowledged, forever. If `onConnect` has not settled within `connectionInitTimeout` after `connection_init`, the socket is now closed with `4408 Connection initialization timeout` (the code and reason of the existing init timeout), and the late result is ignored: no `connection_ack`, no keep-alive timer, and a late rejection is logged through the configured logger instead of closing the socket again.

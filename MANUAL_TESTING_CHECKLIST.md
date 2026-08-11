# WebRTC Auto-Reconnect Manual Testing Checklist

Due to the complex, distributed nature of WebRTC and MQTT signaling, automated E2E tests cannot cover every possible environmental factor. Please use this checklist to manually verify the robustness of the system across physical devices.

## 1. Client Network Drop (Auto-Reconnect)
- [ ] Connect a Host (PC) and Client (Mobile) to the same event.
- [ ] On the Client, submit a scouting record and verify it syncs to the Host.
- [ ] On the Client, turn on **Airplane Mode** (or disable Wi-Fi/Cellular).
- [ ] Observe the Client UI transition to `offline` or `degraded` within ~1-2 seconds.
- [ ] On the Host, submit a new record. (This tests offline caching).
- [ ] On the Client, turn off Airplane Mode.
- [ ] **Expectation**: The Client should automatically reconnect within a few seconds without refreshing the page. The status should turn `connected`.
- [ ] **Expectation**: The record submitted by the Host while offline should immediately appear on the Client's history list.

## 2. Host Network Drop

### Scenario A: Normal Exit (Immediate Broadcast)
- [ ] Connect Host and Client.
- [ ] On the Host, force close the browser tab.
- [ ] **Expectation**: The Client should immediately receive a `HOST_LEAVING` signal (via beforeunload) and transition to `offline` instantly, without waiting for ICE timeout.
- [ ] On the Host, reopen the app and enter the Event room again as Host.
- [ ] **Expectation**: The Host sends a `host_hello` signal. The Client should intercept this and instantly transition back to `connected`.

### Scenario B: Abnormal Exit (ICE Timeout)
- [ ] Connect Host and Client.
- [ ] On the Host, simulate a hard crash (e.g., unplug the ethernet cable, or kill the browser process from Task Manager so `beforeunload` does NOT fire).
- [ ] **Expectation**: The Client does NOT receive a `HOST_LEAVING` broadcast.
- [ ] Wait and time how long it takes for the Client to detect the dropped connection.
- [ ] **Expectation**: The Client's ICE connection state should eventually time out (usually 5-15 seconds depending on the browser) and transition to `offline`, followed by the exponential backoff reconnection attempts.

## 3. Conflict Resolution During Offline Period

### Scenario A: 2-Way Conflict
- [ ] Connect Host and Client.
- [ ] Disconnect the Client's network (Airplane Mode).
- [ ] On the Client, create and submit a record for Match 10, Team 1111.
- [ ] On the Host, create and submit a record for Match 10, Team 1111 (same match/team).
- [ ] Re-enable the Client's network.
- [ ] **Expectation**: Both UI histories should flag the record as a **Conflict** (highlighted/tagged).
- [ ] On the Host, edit the conflict record to be Team 2222.
- [ ] **Expectation**: The conflict flag is cleared on both the Host and the Client instantly.

### Scenario B: 3-Way Conflict (Host + 2 Clients)
- [ ] Connect Host, Client1, and Client2.
- [ ] Disconnect Client1 and Client2 networks.
- [ ] Client1, Client2, and Host each submit a different record for Match 10, Team 1111.
- [ ] Re-enable both Clients' networks.
- [ ] **Expectation**: The record is flagged as a Conflict across all 3 devices.
- [ ] On Host, correct the record.
- [ ] **Expectation**: The conflict flag is cleared across all devices, confirming that the "lazy resolution" (waiting until all conflicts collapse into one) correctly handles >2 divergent records.

## 4. True Mobile Network & TURN Relay (MANDATORY)
*This is the most critical test as it simulates the actual competition environment where devices are behind restrictive firewalls/NATs.*
- [ ] **Setup**: Connect the Host to a mobile hotspot (e.g., Carrier A). Connect the Client to a completely independent cellular network (e.g., Carrier B). Do NOT use the same WiFi or Hotspot.
- [ ] Connect the Client to the Host's event.
- [ ] Check `chrome://webrtc-internals` on either device to confirm they connected using `relay` (TURN) rather than `host` or `srflx`.
- [ ] Submit a few records back and forth to ensure the TURN server successfully relays the DataChannel messages.
- [ ] Perform a brief Airplane Mode toggle on the Client to ensure reconnection works over TURN.

## 5. TURN Traffic Consumption Check
- [ ] After completing all of the above tests (especially Section 4), log into the Metered.ca dashboard.
- [ ] Check the total bandwidth consumed during this testing session.
- [ ] **Goal**: Use this baseline to estimate whether the free 0.5 GB/month tier is sufficient.
      *(Calculation: If a 10-minute intense test uses X MB, calculate `X * (hours of competition) * (number of devices)` to estimate tournament usage).*

## 6. Long Offline (Exponential Backoff Limit)
- [ ] Connect Host and Client.
- [ ] Disconnect the Client's network.
- [ ] Wait for ~45 seconds. Observe the console logs showing backoff attempts (1s, 2s, 4s, 8s, 16s...).
- [ ] **Expectation**: After 6 attempts, the Client stops trying and transitions to a `long_offline` or permanent disconnected state.
- [ ] Manually refresh the Client page to reconnect.

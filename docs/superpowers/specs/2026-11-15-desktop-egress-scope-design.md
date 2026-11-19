# Scope-aware egress for the cloud desktop (Route 2)

**Asked for:** the browser a bot drives is now held to its room's engagement scope (P4a). The cloud desktop is not.
A bot with `exec` or `open_url` reaches any host the desktop's network allows, whatever the room authorized. This
design covers everything that leaves the desktop: `exec`'s shell, `open_url`'s browser, and any GUI application
someone opens on the desktop's screen.

## The gap

`commandScope.call` already refuses `exec` and `open_url` whose command names an off-scope host. That is a check on
the tool call's own text. It cannot see what the command does after it starts: `curl -s $URL` with the host in a
variable, a Python script that opens a socket, `ssh`, `npm install`, a GUI app that syncs on its own, or the desktop
browser following a link after `open_url` allowed the first one. Each of those leaves the desktop by the container's
default bridge network, and nothing on that path asks the room's scope.

So the desktop needs a checkpoint at the network, not at the tool call.

## What the desktop is today

Facts from this tree, not assumptions:

| Fact | Where |
| --- | --- |
| The desktop container runs with no explicit `--network`, so it uses the runtime's default bridge. | `containerRunArgs` (`server/container-computer.ts:774`) pushes labels, caps, mounts and `-p 127.0.0.1::6080`, no `--network` |
| Every capability is dropped and only a short list is added back: `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `FSETID`, `SETGID`, `SETUID` (plus `SYS_CHROOT` on Podman). `NET_ADMIN` and `NET_RAW` are **not** in it. | `desktopCapArgs`, `SUPERVISOR_CAPS`, `PACKAGE_INSTALL_CAPS` (`server/container-isolation.ts:12-16,107`) |
| `exec` runs as `cua` (uid 1000), not root. | `containerExec` (`server/container-computer.ts:1080-1100`) and `cuaExecArgs` (`:470`) both pass `-u cua` |
| No `sudo` is installed for `cua` and no `NOPASSWD` rule exists. | no `sudoers` write in `server/container-isolation.ts` or `server/container-init.ts` |
| The container is not `no-new-privileges` on Linux desktops, because the guest root is the host root there. | `desktopRootIsHostRoot` (`server/container-isolation.ts:49`) |

Two consequences follow, and they set the shape of everything below.

**The bot cannot build its own wall.** Without `NET_ADMIN` a guest `iptables` or `nft` cannot program the netfilter
tables, and `exec` does not even have the root that trying would need. This is a real improvement over what I assumed
before reading the code: a scope gate inside the guest cannot be removed by the bot, because the bot was never able to
write it.

**A guest-side wall would also be the wrong place.** Anything the guest programs is a rule the guest could unset. The
checkpoint belongs outside the container, where the bot has no handle on it.

## Options considered

### A. A sidecar proxy and a network with no other route

Run the desktop on an internal network (`--network omb-desktop-<bot>`) with no gateway to the outside, and put a
small forward proxy on a second network that the desktop and the server share. The desktop's only route out is the
proxy, reached by `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` and by a transparent redirect for applications that ignore
them.

This is the same shape `bot-box` already uses for the engines: an HTTP `CONNECT` proxy inside the box
(`server/bot-box/egress-gate.ts`), bridged to the server's gate, with the browser's SOCKS gate as its twin. The
address policy in `server/browser/egress/policy.ts` is already shared by both, so a third caller adds no new policy.

Cost: a new per-bot network and sidecar, a lifecycle to start, stop and reap them with the desktop, and a transparent
redirect for the applications that do not read proxy variables. Desktop images run many of those: the file manager,
the updater, anything using a raw socket.

### B. Host firewall rules per desktop, matched to the room's scope

Program `nft` rules on the host, keyed by the desktop container's address, allowing only the scope's targets and
refusing everything else. `server/fleet.ts:199` already writes an `nft` table for a related job: fencing a workspace's
loopback ports to its own user.

Cost: the host must be root and must own netfilter. That is true for a self-hosted server and for the desktop app, and
false for a Cloud home, where the desktop is a container inside a managed runtime. The rule set also has to be
rewritten whenever a room's scope changes, from a process that may not be the one that wrote it.

### C. Keep the tool-call check and accept the gap

What ships today. Cheap, and it does catch the accidental case. It does not hold against a command that builds its
destination at run time, which is exactly the case an engagement scope exists to stop.

### D. Refuse to run the desktop without a scope

Refuse every desktop tool call in a room that has a scope but no wall. Safe, and unusable: it removes the desktop from
every engagement.

**Chosen: A, with C kept as the first line.** The tool-call check stays, because it refuses early with a message the
bot can act on. The proxy becomes the enforcement point, because it is the only place the bot cannot reach.

## Design

```
bot's tool call ──▶ commandScope.call (C) ──▶ desktop container
                                                   │  exec, open_url, GUI app
                                                   ▼
                                       HTTP CONNECT / SOCKS proxy   ◀── the room's scope, by name
                                                   │
                                                   ▼
                                    browser/egress policy (addresses)
                                                   │
                                                   ▼
                                              the internet
```

1. **One gate, a third caller.** `BrowserEgress` already opens one SOCKS gate per session, keyed by session, with the
   scope hook P4a added (`EgressSetup.outOfScope`). The desktop gets a gate keyed by its own container name, through
   the same class, so the address policy, the refusal texts and the page-health line stay in one place.

2. **The scope is read per connection, not per gate.** A room's scope can change while a desktop runs: an engagement
   starts, ends, or gains a target. The gate asks on every name, as P4a's `outOfScope(session, host)` does, so a scope
   edited in the middle of a turn takes effect on the next connection.

3. **Identity comes from the desktop, not from the turn.** A GUI app runs with no turn holding it, so
   `turnResources.holder` cannot name its room, and P4a's browser answer (an unheld session is unchecked) would leave
   every GUI app unchecked. The desktop's owner is fixed when the container is created, so the gate resolves the bot
   and room from the desktop record the host already keeps. The container name cannot carry it: `perBotLocalVmTarget`
   names a container from `sha256(botId).slice(0, 16)` (`server/container-computer.ts:100`), so the label is a digest
   and not reversible. The host therefore keeps the name-to-bot mapping in memory for the containers it created, the
   same way P4a's browser path keeps a session-to-turn mapping. A container the host did not create, or one whose
   mapping is gone after a restart, has no room and is unchecked — the safe default is the one that changes nothing,
   and a restart already requires the desktop to be recreated to pick up the network.

4. **No scope, no change.** A room with no engagement scope, and a desktop whose bot is in no room, keep today's
   behaviour. A scope that is set but not yet started, or already ended, refuses everything, which is what
   `scopeActive` already does for commands.

5. **The refusal surfaces where the person looks.** The gate's line names the host and says it is outside the
   engagement's authorized scope. The desktop's screen shows the application's own network error, which is what a
   person watching the desktop sees; the bot's next tool call gets the gate's line, as its browser already does.

## What this does not solve

- **A destination reached by address.** The scope matches names. A command that resolves a target itself and connects
  to the address is held only by the address policy, which allows public addresses. Closing that needs the proxy to
  own resolution and the desktop to have no other route, which option A provides only for the applications that honour
  it.
- **The person's own desktop.** On the desktop app the "cloud desktop" is the person's computer, outside any
  container. Nothing here applies, and nothing should: a scope is an authorization for targets, not a restriction on
  the machine the person is sitting at.
- **Bandwidth and time.** A scope says where a bot may go, not how much it may take. Rate limits and time windows are
  separate work.

## Rollout

1. `BrowserEgress` gains a gate keyed by container name and an `outOfScope` reader that takes a bot and room from the
   container's labels. No behaviour change while no desktop passes a scope.
2. The per-bot network and sidecar land behind a config flag, with the default bridge as the fallback, so an existing
   desktop keeps its network until it is recreated.
3. The flag defaults on for a new desktop created in a room that has a scope.
4. The tool-call check (C) stays in both states. It is the message the bot reads; the proxy is the wall.

## Tests

- A desktop with no scope reaches a public host, unchanged.
- A desktop in a room with a scope reaches an in-scope host and is refused an off-scope one, by name, before any DNS
  query, as `registry.test.ts` already asserts for a browser session.
- A GUI app, modelled as a connection that no tool call made, is refused on the same gate.
- A scope edited between two connections takes effect on the second.
- A scope window that has ended refuses every name, and says which side of the window it is.
- A desktop whose bot is in no room is unchecked.

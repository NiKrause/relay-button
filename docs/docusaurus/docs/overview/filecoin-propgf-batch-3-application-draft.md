# Filecoin ProPGF Batch 3 Proposal Notes

This page captures the public-facing outline for a Filecoin ProPGF Batch 3
proposal aligned with Focus Area 1: customer-facing products built on
Filecoin.

The proposal is centered on a decentralized Filecoin archive, upload, and
pinning gateway for local-first peer-to-peer applications. It is meant to read
as product and architecture notes rather than as a verbatim grant form export.

## Proposal At A Glance

We want to build a customer-facing product that helps local-first applications
use Filecoin-backed archival without falling back to a traditional centralized
backend.

The proposed product combines:

- an IPFS-hosted, UCAN-based upload PWA
- Filecoin archival visibility for uploaded content
- IPFS and OrbitDB pinning for application data continuity
- relay continuity for IPFS-hosted peer-to-peer applications whose peers go
  offline
- disaster recovery and re-hydration flows for failed gateway deployments
- a deployment path on decentralized compute, starting with one production
  target and keeping the architecture portable to others

The goal is to make verifiable Filecoin storage usable inside real
local-first, peer-to-peer applications that are user-owned, portable, and
censorship-resistant.

## The Problem

Local-first and peer-to-peer applications can be highly resilient from a user
ownership perspective, but they still face practical availability problems:

- browser or mobile peers go offline
- application data needs pinning or archival somewhere durable
- upload and authorization flows often drift back toward centralized services
- relay continuity becomes an extra operational burden for app builders

This creates a gap between the promise of local-first software and the reality
of operating it at product level. Filecoin-backed archival is a strong match
for this problem space, but many application builders still need a practical,
customer-facing path rather than only low-level infrastructure.

## Proposed Product

The product is a gateway and continuity layer for local-first peer-to-peer
applications, designed to run on decentralized compute.

On the front end, users interact with an IPFS-hosted upload PWA that uses
UCAN-based authorization patterns and stays aligned with local-first
principles. On the storage side, the service exposes Filecoin archival
visibility and durable content references rather than acting as a black box.
On the continuity side, the product extends beyond uploads into OrbitDB and
IPFS pinning, plus relay support for IPFS-hosted applications that need their
networking to stay reachable when end-user devices are offline.

The recovery path is part of the product story as well. If a decentralized
compute node running the gateway fails, the system should be able to re-deploy
a replacement node and re-hydrate it from Filecoin-archived durable artifacts
and application data. Those recovery inputs may include deployment manifests,
infrastructure image references, gateway configuration, uploaded files, and
OrbitDB recovery checkpoints or snapshots. Recovery authorization should remain
user-controlled and can be mediated through passkey-backed identity rather than
a centralized admin backend.

The architecture is intentionally open and modular:

- upload UX stays browser-first
- authorization stays user-controlled
- archival is verifiable
- pinning and relay continuity are deployable on decentralized compute, while
  Filecoin-backed archival preserves the durable artifacts and data needed to
  recover and re-hydrate the gateway after failure
- application builders can adopt the product without introducing a new token,
  new chain, or proprietary backend dependency

## Why This Fits Filecoin

This work is not aimed at inventing a new protocol token or speculative
economic layer. The value is in making Filecoin-backed archival visible and
usable as an application feature.

Instead of treating Filecoin as something hidden behind an infrastructure
provider, the product makes archival part of the normal workflow for local-first
applications:

- upload content from an IPFS-hosted PWA
- preserve durable references and archival visibility
- keep OrbitDB and IPFS application data available
- preserve networking continuity through libp2p relay support
- preserve the durable artifacts and data needed for disaster recovery and
  re-hydration
- let builders ship user-owned applications with stronger durability

That is the main reason this proposal is framed as a customer-facing product
rather than as generic infrastructure work.

## Three-Stage Roadmap

The current delivery plan is organized into three two-month stages across a
six-month grant period.

### Stage 1

Build and harden the IPFS-hosted UCAN upload PWA and connect it to a
Filecoin-backed archival gateway running on one selected decentralized compute
network.

This stage is about getting the customer-facing upload and archival experience
into a usable product shape:

- browser-first upload flow
- UCAN-based authorization
- content CID and archival visibility outputs
- public documentation and demo flows
- one supported decentralized compute deployment target

### Stage 2

Extend the gateway with OrbitDB and IPFS pinning plus relay continuity for
local-first applications.

This stage focuses on application availability when original peers are offline.
It uses OrbitDB Voyager and orbitdb-relay as technical reference points
while keeping the end result focused on a coherent product:

- documented pinning and replication continuity flows
- at least one reproducible relay and pinning deployment profile
- integration guidance for IPFS-hosted OrbitDB-style applications
- a practical path for applications to launch or sponsor continuity services

### Stage 3

Integrate passkey-based peer replication, recovery authorization, and disaster
re-hydration with the archival and pinning stack.

This stage is about making local-first applications more recoverable and
multi-device friendly without abandoning user ownership:

- passkey-based recovery and replication patterns
- re-deploy and re-hydrate flows for failed gateway nodes on fresh
  decentralized compute
- example multi-peer or multi-device recovery demos
- an end-to-end disaster recovery demo restoring gateway artifacts, files, and
  OrbitDB-backed state
- public builder documentation
- documented security notes and known limitations

## Delivery Principles

The proposal is guided by a few simple constraints:

- fully open source
- no new token or chain
- customer-facing product first, not SDK-only scope
- one production-grade decentralized compute target first
- portable architecture that can later support additional decentralized compute
  environments
- disaster recovery must focus on durable recovery artifacts, not on claiming
  perfect hot failover
- emphasis on user-owned and censorship-resistant application patterns

## What Success Looks Like

By the end of the grant period, the intended outcome is not just a set of
components but a usable application layer path for builders:

- local-first applications can use an IPFS-hosted upload PWA with UCAN-based
  authorization
- uploaded content has visible Filecoin archival information
- OrbitDB and IPFS application data can remain available when browser peers are
  offline
- IPFS-hosted applications have a documented relay continuity path
- a failed gateway deployment can be re-deployed on fresh decentralized
  compute and re-hydrated from Filecoin-archived artifacts and application data
- builders can adopt the system without moving back to a centralized backend

In short, the product should help move Filecoin-backed archival from hidden
infrastructure into an understandable, user-facing feature for real local-first
applications, including a practical recovery path when gateway infrastructure
fails.

## Public Reference Projects

These projects are relevant technical references for the current proposal
direction:

- [NiKrause/ucan-upload-wall](https://github.com/NiKrause/ucan-upload-wall)
- [NiKrause/relay-button](https://github.com/NiKrause/relay-button/)
  infrastructure for on-demand relay instance hosting
- [orbitdb/voyager](https://github.com/orbitdb/voyager)
- [NiKrause/orbitdb-relay](https://github.com/NiKrause/orbitdb-relay)
- [NiKrause/simple-todo](https://github.com/NiKrause/simple-todo)
  a demo for a simple p2p app working with orbitdb-relay
- [asabya/p2pass](https://asabya.github.io/p2pass/)

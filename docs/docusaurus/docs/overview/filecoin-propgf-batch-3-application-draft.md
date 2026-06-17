# Filecoin ProPGF Batch 3 Application Draft

This page captures the current public-facing draft copy for a Filecoin ProPGF
Batch 3 application responding to Focus Area 1: Customer-facing products built
on Filecoin.

The proposal centers on a decentralized Filecoin archive, upload, and pinning
gateway for local-first peer-to-peer applications. It intentionally excludes
private reviewer-only details such as named references, confidential operating
data, and internal budget notes that belong in the application form rather than
the public docs site.

## Suggested Form Values

- Project name:
  `Decentralized Filecoin Archive, Upload, and Pinning Gateway for Local-First P2P Applications`
- Category:
  `RFP Response` for Batch 3 Focus Area 1: Customer-facing products built on
  Filecoin
- Open source status: `Fully Open Source`
- Beneficiaries:
  - `Application Builders`
  - `Application Users`
  - `Network Infrastructure`
  - `Storage Providers`
- Total funding requested: `$200,000`
- Grant period: `2026-08-01` to `2027-01-31`
- Delivery shape: three two-month milestones

## Project Summary

We propose a customer-facing Filecoin-backed archive, upload, and
IPFS/OrbitDB pinning gateway for local-first peer-to-peer applications. The
product combines an IPFS-hosted, UCAN-based upload PWA, Filecoin archival
visibility, OrbitDB/IPFS pinning, and on-demand relay continuity for
IPFS-hosted applications that need their data and networking to stay available
when end-user devices go offline. The first phase hardens a local-first upload
wall and deploys the archival gateway on one decentralized compute network,
while later phases add OrbitDB pinning and passkey-based peer replication and
recovery. This supports application builders and end users who want
Filecoin-backed durability without having to run a centralized backend, and it
creates a practical path for local-first applications to adopt Filecoin
archival as part of normal product flows. We are not introducing a new token or
chain; the goal is to make verifiable Filecoin storage usable inside real
customer-facing applications that are user-owned and censorship-resistant.

## Open Source Context

This project will be fully open source. The upload PWA, archival gateway
components, pinning and relay continuity flows, deployment tooling, and
reference integrations will be developed in public with reproducible deployment
instructions and public documentation. We are not proposing a proprietary
chain, token, or closed backend. The goal is to provide open, user-owned
building blocks and a finished customer-facing product that help local-first
applications adopt Filecoin-backed archival without surrendering control to
centralized infrastructure.

## Milestones And Budget

### Milestone 1

**Title**

IPFS-hosted UCAN upload PWA and Filecoin archival gateway on one decentralized
compute network

**Due date**

`2026-09-30`

**Funding requested**

`$66,667`

**Description**

Build and harden a customer-facing, IPFS-hosted UCAN upload PWA and connect it
to a Filecoin-backed archival gateway deployed on one selected decentralized
compute network. This milestone uses Storacha-compatible technical patterns and
a browser-first local-first upload wall as the implementation starting point,
while focusing on production hardening, user-facing flows, archival visibility,
and deployment portability. The result is a usable product for browser-native
uploads where authorization remains client-side and users do not need to trust
a traditional centralized backend.

**Completion criteria**

- A browser-first upload PWA is live from IPFS and supports UCAN-based
  authorization flows.
- The archival gateway is deployed and documented on one decentralized compute
  target.
- Upload outputs expose content CIDs and a working Filecoin archival
  information path.
- Public operator and user documentation is published, along with a working
  demo flow for end users and developers.

### Milestone 2

**Title**

OrbitDB/IPFS pinning and relay continuity for local-first applications

**Due date**

`2026-11-30`

**Funding requested**

`$66,667`

**Description**

Extend the archival gateway with OrbitDB/IPFS pinning and replication
continuity using OrbitDB Voyager and orbitdb-relay-pinner as technical
references. This milestone focuses on keeping application data available when
originating browser peers are offline and on enabling IPFS-hosted local-first
applications to launch or sponsor relay continuity on decentralized compute. It
includes at least one documented deployment profile, reference integration
flows for OrbitDB-based applications, and published operational guidance for
pinning, replication, and relay continuity.

**Completion criteria**

- OrbitDB pinning and continuity flows are working on the selected
  decentralized compute target.
- At least one relay and pinning deployment profile is reproducible and
  publicly documented.
- An IPFS-hosted local-first application can use the documented relay
  continuity flow.
- Reference integration material is published for OrbitDB-style applications.

### Milestone 3

**Title**

Passkey-based peer replication and recovery integrated with Filecoin archival
and OrbitDB pinning

**Due date**

`2027-01-31`

**Funding requested**

`$66,666`

**Description**

Add passkey-based peer replication and recovery patterns to the stack so
local-first applications can recover state and continue synchronization across
devices while using the archival and pinning flows from Milestones 1 and 2.
This milestone uses p2pass as a reference prototype and aligns passkey-backed
identity with OrbitDB pinning and user-controlled continuity. The goal is to
make local-first applications more durable, user-owned, and censorship-resistant
without falling back to a centralized service model.

**Completion criteria**

- A passkey-based replication demo is integrated with the archival and pinning
  path.
- Recovery and sync are demonstrated across multiple peers or devices.
- Public example code and integration documentation are published for builders.
- Security notes and known limitations are documented.

## Target Network Objectives And KPIs

- Drive Paid Onchain Deals: `Indirect`
- Strengthen Network Profitability & Cryptoeconomics: `Indirect`
- Scale Paid Onchain Flagship Client Adoption: `Direct`

## Impact Pathway

This work creates a practical path for user-owned, censorship-resistant
local-first applications to use Filecoin-backed archival as part of normal
product behavior. The immediate outputs are an IPFS-hosted upload PWA, a
Filecoin archival gateway, OrbitDB/IPFS pinning, and relay continuity for
applications that need their data and networking to remain available when
end-user devices are offline. Those outputs let application builders ship
browser-native products without operating a traditional centralized backend
while still benefiting from verifiable archival and continuity infrastructure.
The resulting outcome is that more local-first applications can become durable,
recoverable, and multi-device friendly while using Filecoin as their long-term
storage substrate. That directly supports flagship client adoption by turning
Filecoin-backed archival into a visible customer feature rather than a hidden
infrastructure detail.

## Verification Metrics

### Metric 1

**Metric**

Number of Filecoin deal IDs associated with archived uploads produced by the
gateway.

**Data source**

Archival outputs and Filecoin archival information lookups.

**How it is measured**

Count unique deal IDs observed for data archived through the product.

**Target by end of grant**

At least 100 observed deals across pilot application data.

### Metric 2

**Metric**

Total bytes with verifiable Filecoin archival through the product.

**Data source**

Upload logs, content CIDs, piece CIDs, and archival proof lookups.

**How it is measured**

Sum bytes for uploads whose archival status can be externally verified.

**Target by end of grant**

At least 250 GB of archived data across pilots.

### Metric 3

**Metric**

Externally verifiable product adoption and continuity metrics.

**Data source**

Public demos, deployment docs, published integrations, and service telemetry.

**How it is measured**

Count completed pilot integrations, supported decentralized compute targets,
OrbitDB database addresses under documented pinning flows, and public demos
showing relay continuity or passkey-based recovery.

**Target by end of grant**

At least 3 pilot application integrations, at least 1 decentralized compute
target supported in production, at least 10 OrbitDB database addresses under
documented pinning flows, and at least 2 public demos showing relay continuity
or passkey-based recovery.

## If The Grant Is Not Awarded

Without this grant, the underlying prototypes would likely continue only as
slower part-time work across separate repositories rather than as one
integrated customer-facing Filecoin product. The likely result would be delayed
hardening of the IPFS-hosted upload PWA, slower rollout of OrbitDB pinning and
relay continuity, and a significant delay in integrating passkey-based
replication and recovery. The ideas would still be technically possible, but
the end-to-end productization, documentation, and pilot deployments would
likely slip by at least 6 to 12 months.

## Key Risks And Dependencies

The main risks are production-hardening browser-first and prototype-stage
components, operating a customer-facing archival service reliably on
decentralized compute, and aligning UCAN authorization, IPFS, OrbitDB, relay
continuity, and passkey-based identity across browser and service layers.
Upstream dependencies include Storacha-compatible protocols and client flows,
the maturity of OrbitDB and related replication tooling, and the ingress,
persistence, and networking characteristics of the selected decentralized
compute platform. We reduce risk by delivering first on one compute target,
keeping the architecture modular, publishing reference deployments at each
phase, and documenting security assumptions and known limitations as part of
every milestone.

## Other Notes

We are deliberately not proposing a new token, a new chain, or a speculative
economic layer. The value of this project is to make Filecoin-backed archival,
pinning, and continuity usable inside real local-first applications through
browser-first UX, open-source implementations, and portable deployment patterns
on decentralized compute. We also believe this work is meaningfully aligned
with user-owned and censorship-resistant software: the product is designed so
applications can remain browser-native and IPFS-hosted while still gaining
durable archival and continuity services.

## Application Process Feedback

The RFP direction is clear and helpful. The main improvement would be making
the form labels and category options match the latest Batch 3 focus area
wording exactly, and showing the expected milestone date format more explicitly
inside the form UI.

## Public Reference Projects

- [NiKrause/ucan-upload-wall](https://github.com/NiKrause/ucan-upload-wall)
- [orbitdb/voyager](https://github.com/orbitdb/voyager)
- [NiKrause/orbitdb-relay-pinner](https://github.com/NiKrause/orbitdb-relay-pinner)
- [asabya/p2pass](https://asabya.github.io/p2pass/)

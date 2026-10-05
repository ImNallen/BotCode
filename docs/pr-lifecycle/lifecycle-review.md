# Lifecycle review

Conversations can complete the saved PR workflow through explicit lifecycle confirmations and move to Settled after eligible linked pull requests merge. An uncertain update retains its original evidence and offers explicit continuation from a freshly inspected changed head.

The independent review accepted the final 36-path source with no actionable P0, P1 or P2 findings. It inspected all18 recovery paths and affected callers. The other 18 paths match the previously reviewed correction exactly. The comment audit retained API documentation and upstream attribution and found no suppression required. The [verification record](lifecycle-verification.md) covers the actual native gate.

## Review choices

The existing Owner remains the only SQLite writer. Commands capture canonical PR identity, head and viewer; provider reads validate them before mutation. Receipts keep immutable input and digest. Conditional completion preserves a durable terminal winner when older work finishes late.

One `Superseded` result records either a fresh same-node merged observation or explicit continuation from an inspected changed head. A second durable recovery field would create competing finality rules. An observed head change alone does not release an uncertain update, because it cannot prove that GitHub cancelled or completed the earlier operation.

Reconcile stays read-only. Continue rereads the inspected identity and persists the result before removing the blocker. A failed read, changed identity, lost membership or storage failure preserves pending work. Review uncertainty remains outside lifecycle recovery.

Merge settlement uses all saved links, trustworthy activity timestamps and placement guards. Its device and project settings are independent from idle settlement. Legacy conversations without a trustworthy activity anchor stay conservative until actual user work supplies one.

The source review and native proof do not establish GitHub's asynchronous execution timing. The UI states that the earlier outcome is unknown and continuation does not cancel that operation.

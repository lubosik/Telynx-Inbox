import Foundation

struct AssistantEvidenceReference: Hashable, Sendable {
    let token: AssistantEvidenceToken
    let source: AssistantEvidenceSource
    let scope: AssistantEvidenceScope
    let factIDs: [String]
    let claims: [AssistantGroundedClaim]
    let generatedAt: String
    let destination: AssistantEvidenceDestination
    let requiredPermission: AssistantBusinessPermission
}

struct AssistantEvidenceGeneration: Hashable, Sendable {
    fileprivate let value: UUID
}

enum AssistantEvidenceRegistryError: Error {
    case capacityExceeded
}

/// Memory-only evidence behind facts shown by the Assistant.
///
/// The registry is deliberately an actor because Foundation Models may call
/// several read tools concurrently. It has no persistence or logging path.
/// Calling `clear()` on dismissal, backgrounding, calls, sign out and identity
/// changes removes both the evidence and private navigation identifiers.
actor AssistantEvidenceRegistry {
    static let maximumReferences = 200
    /// At most 160 committed citations can be visible. Reserving the remaining
    /// 40 slots for one active request means an unexpected larger read fails
    /// closed instead of evicting evidence behind an on-screen citation.
    static let maximumReferencesPerRequest = 40

    private var order: [String] = []
    private var references: [String: AssistantEvidenceReference] = [:]
    private var referenceGenerations: [String: AssistantEvidenceGeneration] = [:]
    private var activeGeneration = AssistantEvidenceGeneration(value: UUID())

    func generation() -> AssistantEvidenceGeneration {
        activeGeneration
    }

    func beginGeneration() -> AssistantEvidenceGeneration {
        // Rotate the write fence without deleting citations that are still
        // visible in the in-memory transcript. Older generations are sealed:
        // they remain readable by token, but can no longer register facts.
        activeGeneration = AssistantEvidenceGeneration(value: UUID())
        return activeGeneration
    }

    @discardableResult
    func register(source: AssistantEvidenceSource,
                  scope: AssistantEvidenceScope,
                  factIDs: [String],
                  claims: [AssistantGroundedClaim],
                  generatedAt: String,
                  destination: AssistantEvidenceDestination,
                  requiredPermission: AssistantBusinessPermission,
                  generation: AssistantEvidenceGeneration) throws -> AssistantEvidenceToken {
        try Task.checkCancellation()
        guard generation == activeGeneration else { throw CancellationError() }
        let generationCount = referenceGenerations.values.lazy
            .filter { $0 == generation }
            .count
        guard generationCount < Self.maximumReferencesPerRequest,
              references.count < Self.maximumReferences else {
            throw AssistantEvidenceRegistryError.capacityExceeded
        }
        let token = AssistantEvidenceToken(value: UUID().uuidString.lowercased())
        let cleanFactIDs = Array(factIDs.lazy
            .map { String($0.prefix(128)) }
            .filter { !$0.isEmpty }
            .prefix(100))
        references[token.value] = AssistantEvidenceReference(
            token: token,
            source: source,
            scope: scope,
            factIDs: cleanFactIDs,
            claims: Array(claims.prefix(50)),
            generatedAt: generatedAt,
            destination: destination,
            requiredPermission: requiredPermission
        )
        referenceGenerations[token.value] = generation
        order.append(token.value)
        return token
    }

    func reference(for token: AssistantEvidenceToken) -> AssistantEvidenceReference? {
        references[token.value]
    }

    func references(for generation: AssistantEvidenceGeneration) -> [AssistantEvidenceReference] {
        order.compactMap { token in
            guard referenceGenerations[token] == generation else { return nil }
            return references[token]
        }
    }

    /// Seals a successful request and keeps only citations the deterministic
    /// renderer actually exposed. Per-record rows fetched for bounded analysis
    /// cannot consume capacity or evict still-visible transcript evidence.
    func commit(_ generation: AssistantEvidenceGeneration,
                retaining tokens: Set<AssistantEvidenceToken>) throws {
        try Task.checkCancellation()
        guard generation == activeGeneration else { throw CancellationError() }
        let retainedValues = Set(tokens.map(\.value))
        let removable = Set(referenceGenerations.compactMap { token, storedGeneration in
            storedGeneration == generation && !retainedValues.contains(token) ? token : nil
        })
        remove(values: removable)
        activeGeneration = AssistantEvidenceGeneration(value: UUID())
    }

    /// Releases citations removed by the bounded in-memory transcript.
    func remove(tokens: Set<AssistantEvidenceToken>) {
        remove(values: Set(tokens.map(\.value)))
    }

    /// Removes only provisional evidence for one failed/cancelled request.
    /// Evidence belonging to earlier transcript entries stays resolvable.
    func discard(_ generation: AssistantEvidenceGeneration) {
        let discarded = Set(referenceGenerations.compactMap { token, storedGeneration in
            storedGeneration == generation ? token : nil
        })
        guard !discarded.isEmpty || generation == activeGeneration else { return }
        remove(values: discarded)
        if generation == activeGeneration {
            activeGeneration = AssistantEvidenceGeneration(value: UUID())
        }
    }

    func clear() {
        activeGeneration = AssistantEvidenceGeneration(value: UUID())
        order.removeAll(keepingCapacity: false)
        references.removeAll(keepingCapacity: false)
        referenceGenerations.removeAll(keepingCapacity: false)
    }

    var count: Int { references.count }

    private func remove(values: Set<String>) {
        guard !values.isEmpty else { return }
        order.removeAll { values.contains($0) }
        values.forEach {
            references.removeValue(forKey: $0)
            referenceGenerations.removeValue(forKey: $0)
        }
    }
}

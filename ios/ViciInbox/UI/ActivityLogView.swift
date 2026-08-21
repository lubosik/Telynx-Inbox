import SwiftUI

/// The team activity log: who did what, when.
///
/// Reached from Settings and from the Automations toolbar. It is deliberately
/// not a sixth tab — the TabView already carries five, and a sixth collapses
/// into the "More" overflow on smaller iPhones.
struct ActivityLogView: View {
    @StateObject private var model: ActivityLogModel

    init(category: AuditCategory = .all) {
        _model = StateObject(wrappedValue: ActivityLogModel(category: category))
    }

    var body: some View {
        List {
            Section {
                Picker("Category", selection: $model.category) {
                    ForEach(AuditCategory.allCases) { category in
                        Text(category.label).tag(category)
                    }
                }
                Picker("Person", selection: $model.actorID) {
                    Text("Everyone").tag(String?.none)
                    ForEach(model.actors) { actor in
                        Text(actor.name).tag(String?.some(actor.id))
                    }
                }
                .disabled(model.actors.isEmpty)
            }

            if model.isLoading && model.items.isEmpty {
                Section { ProgressView().frame(maxWidth: .infinity) }
            } else if model.items.isEmpty {
                Section {
                    EmptyState(icon: "clock.arrow.circlepath",
                               title: "No activity",
                               detail: "Nothing matches this filter yet.")
                }
            }

            ForEach(model.sections) { section in
                Section(section.title) {
                    ForEach(section.items) { item in
                        AuditRow(item: item, showsDay: false)
                            .onAppear {
                                Task { await model.loadMoreIfNeeded(after: item) }
                            }
                    }
                }
            }

            if model.isLoadingMore {
                Section { ProgressView().frame(maxWidth: .infinity) }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Activity")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await model.reload() }
        .task {
            await model.loadActors()
            await model.loadIfNeeded()
        }
        .onChange(of: model.category) { _ in Task { await model.reload() } }
        .onChange(of: model.actorID) { _ in Task { await model.reload() } }
        .alert("Activity error", isPresented: Binding(
            get: { model.errorMessage != nil },
            set: { if !$0 { model.errorMessage = nil } }
        )) { Button("OK", role: .cancel) {} } message: {
            Text(model.errorMessage ?? "Unknown error")
        }
    }
}

/// The change history of a single record, e.g. one scheduled message:
/// "scheduled by the hold flow at 09:12, cancelled by Dominic at 14:32".
struct EntityHistoryView: View {
    @StateObject private var model: EntityHistoryModel
    private let title: String

    init(entityType: String, entityID: String, title: String = "History") {
        _model = StateObject(wrappedValue: EntityHistoryModel(entityType: entityType,
                                                              entityID: entityID))
        self.title = title
    }

    var body: some View {
        Group {
            if model.isLoading && model.items.isEmpty {
                ProgressView("Loading history…")
            } else if model.items.isEmpty {
                EmptyState(icon: "clock.arrow.circlepath",
                           title: "No history",
                           detail: "Nothing has been recorded against this item yet.")
            } else {
                List {
                    ForEach(model.items) { item in
                        Section {
                            AuditRow(item: item, showsDay: true)
                            ForEach(item.fieldChanges) { change in
                                FieldChangeRow(change: change)
                            }
                        }
                    }
                }
                .listStyle(.insetGrouped)
            }
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await model.load() }
        .task { await model.load() }
        .alert("History error", isPresented: Binding(
            get: { model.errorMessage != nil },
            set: { if !$0 { model.errorMessage = nil } }
        )) { Button("OK", role: .cancel) {} } message: {
            Text(model.errorMessage ?? "Unknown error")
        }
    }
}

/// One audit row.
///
/// `summary` is printed as it arrived. It is composed server-side at write
/// time, so a row written years ago still reads correctly after the product
/// copy changes. There is deliberately no eventType-to-copy switch here.
struct AuditRow: View {
    let item: AuditItem
    let showsDay: Bool

    private static let timeFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .none
        formatter.timeStyle = .short
        return formatter
    }()

    private static let dayTimeFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter
    }()

    private var timestamp: String? {
        guard let date = item.occurredDate else { return nil }
        return showsDay
            ? Self.dayTimeFormatter.string(from: date)
            : Self.timeFormatter.string(from: date)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline) {
                Text(item.actorName)
                    .font(.subheadline.weight(.semibold))
                if let role = item.actorRole, !role.isEmpty {
                    Text(RoleCatalog.label(role))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 8)
                if let timestamp {
                    Text(timestamp)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Text(item.summaryText)
                .font(.subheadline)
                .fixedSize(horizontal: false, vertical: true)

            HStack(spacing: 6) {
                if let severity = item.severity, severity.lowercased() != "info" {
                    Text(severity.capitalized)
                        .font(.caption2.weight(.semibold))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(severityColor(severity).opacity(0.16))
                        .foregroundColor(severityColor(severity))
                        .clipShape(Capsule())
                }
                if let phone = item.contactPhone, !phone.isEmpty {
                    Text(PhoneFormatter.pretty(phone))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 3)
    }

    private func severityColor(_ severity: String) -> Color {
        switch severity.lowercased() {
        case "critical", "error", "danger": return ViciTheme.destructive
        case "warning", "warn": return ViciTheme.warning
        default: return ViciTheme.tint
        }
    }
}

private struct FieldChangeRow: View {
    let change: AuditFieldChange

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(change.field
                    .replacingOccurrences(of: "_", with: " ")
                    .replacingOccurrences(of: "-", with: " ")
                    .capitalized)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            HStack(spacing: 6) {
                Text(change.before ?? "—")
                    .strikethrough(change.before != nil && change.after != nil)
                    .foregroundStyle(.secondary)
                Image(systemName: "arrow.right")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Text(change.after ?? "—")
            }
            .font(.footnote)
            .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.vertical, 2)
    }
}

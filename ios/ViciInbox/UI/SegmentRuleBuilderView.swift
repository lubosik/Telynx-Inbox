import SwiftUI

/// Describe an audience in plain words and get a segment.
///
/// THE SHAPE OF THIS SCREEN IS THE ARGUMENT
///   Type a sentence. Press "See who this matches". Read the rules the model
///   drafted, in plain English. Change a number or a date if it got one wrong.
///   Look at the count and at some of the people. Name it. Save.
///
///   The model never creates the segment. It drafts rules, a person reads
///   them, and the person publishes. That is Klaviyo's design, it is what
///   `docs/campaigns/TRACKING-AND-LEARNING-RESEARCH.md` says works, and the
///   reason it works is that the operator ends up holding a definition they
///   can read rather than a list of people they have to trust.
///
/// THE COUNT IS NOT A CONFIRMATION STEP
///   The research is explicit that a live count while building is the thing
///   that stops somebody shipping a segment matching three people or nine
///   hundred. So Save is unreachable until a preview of the CURRENT rules has
///   come back, and changing a rule takes it away again. That rule lives in
///   `SegmentRuleBuilderModel.canSave`, not in this file, so it cannot be lost
///   by rearranging a view.
///
/// PERMISSIONS
///   `campaigns.manage`, like every other way of changing a segment. A Support
///   Agent never reaches this screen: `SegmentsView` hides the entry point and
///   all three endpoints answer them 403.
struct SegmentRuleBuilderView: View {
    @ObservedObject var listModel: SegmentListModel
    @Environment(\.dismiss) private var dismiss
    @StateObject private var model = SegmentRuleBuilderModel()
    @FocusState private var descriptionFocused: Bool
    @State private var editing: SegmentRuleEditTarget?

    var body: some View {
        NavigationStack {
            Form {
                describeSection

                switch model.stage {
                case .empty:
                    howItWorksSection
                case .rules:
                    rulesSection
                    previewSection
                    nameSection
                case .question(let questions):
                    questionsSection(questions)
                case .unanswerable(let because):
                    unanswerableSection(because)
                case .rejected(let problems):
                    rejectedSection(problems)
                }

                Section {
                    SegmentSafetyNotice()
                }
            }
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle("Describe a segment")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(model.isSaving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(model.isSaving ? "Saving" : "Save") { save() }
                        .disabled(!model.canSave)
                }
            }
            .interactiveDismissDisabled(model.isSaving)
            .sheet(item: $editing) { target in
                SegmentRuleConditionEditor(target: target) { updated in
                    model.update(updated, at: target.index)
                }
            }
            .alert("Something went wrong", isPresented: Binding(
                get: { model.errorMessage != nil },
                set: { if !$0 { model.errorMessage = nil } }
            )) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(model.errorMessage ?? "Please try again.")
            }
        }
    }

    // MARK: - Describing

    private var describeSection: some View {
        Section {
            TextField(SegmentRuleCopy.placeholder, text: $model.description, axis: .vertical)
                .lineLimit(3...6)
                .focused($descriptionFocused)
                .textInputAutocapitalization(.sentences)
                .disabled(model.isBusy)

            if let problem = model.descriptionProblem {
                Text(problem)
                    .font(.footnote)
                    .foregroundColor(ViciTheme.destructive)
            }

            Button {
                descriptionFocused = false
                Task { await model.draftAndPreview() }
            } label: {
                if model.isDrafting {
                    Label("Working out the rules", systemImage: "hourglass")
                } else if model.isPreviewing {
                    Label("Counting who matches", systemImage: "hourglass")
                } else {
                    Label("See who this matches", systemImage: "person.3.sequence")
                }
            }
            .disabled(!model.canDraft)
        } header: {
            Text("Describe the audience")
        } footer: {
            Text("Say it the way you would say it out loud. Orders, products, spend, timing, how regularly somebody orders, other segments, and whether they are clear for commercial contact are all things this can work from.")
        }
    }

    private var howItWorksSection: some View {
        Section {
            SegmentRuleStep(number: 1, text: "You describe the audience.")
            SegmentRuleStep(number: 2, text: "Rules are drafted from your sentence and shown to you in plain English.")
            SegmentRuleStep(number: 3, text: "You see how many people match, and some of who they are.")
            SegmentRuleStep(number: 4, text: "You change anything that is wrong, then save.")
        } header: {
            Text("How this works")
        } footer: {
            Text("Nothing is saved until you press Save. Your sentence and the product names are all that is sent for the drafting step; no customer is.")
        }
    }

    // MARK: - The rules

    private var rulesSection: some View {
        Section {
            Picker("Match", selection: Binding(
                get: { model.ruleSet?.match ?? .all },
                set: { model.setMatch($0) }
            )) {
                Text("All of these").tag(SegmentRuleMatch.all)
                Text("Any of these").tag(SegmentRuleMatch.any)
            }
            .pickerStyle(.segmented)
            .disabled(model.isBusy)

            if let rules = model.ruleSet {
                ForEach(Array(rules.conditions.enumerated()), id: \.offset) { index, condition in
                    SegmentRuleConditionRow(
                        condition: condition,
                        plainEnglish: model.plainEnglish?.line(at: index),
                        isStale: model.editedSincePreview,
                        canRemove: model.canRemoveConditions,
                        edit: { editing = SegmentRuleEditTarget(index: index, condition: condition) },
                        remove: { model.remove(at: index) }
                    )
                }
            }

            if model.editedSincePreview {
                Button {
                    Task { await model.runPreview() }
                } label: {
                    Label(model.isPreviewing ? "Counting who matches" : "See who this matches now",
                          systemImage: model.isPreviewing ? "hourglass" : "arrow.clockwise")
                }
                .disabled(model.isBusy)
            }
        } header: {
            Text("The rules")
        } footer: {
            if model.editedSincePreview {
                Text(SegmentRuleCopy.editedSincePreview)
            } else {
                Text("Tap a rule to change a number or a date. To use a different kind of rule, change your sentence and look again.")
            }
        }
    }

    // MARK: - The dry run

    @ViewBuilder
    private var previewSection: some View {
        if let preview = model.preview {
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    Text(preview.countSentence)
                        .font(.title3.weight(.semibold))
                        .foregroundStyle(model.editedSincePreview ? Color.secondary : Color.primary)
                    if model.editedSincePreview {
                        Text(SegmentRuleCopy.editedSincePreview)
                            .font(.footnote)
                            .foregroundColor(ViciTheme.warning)
                            .fixedSize(horizontal: false, vertical: true)
                    } else if let sentence = model.plainEnglish?.sentence {
                        Text(sentence)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(.vertical, 2)

                ForEach(model.warnings) { warning in
                    SegmentRuleWarningRow(warning: warning)
                }

                if !preview.sample.isEmpty {
                    Text(preview.sampleSentence)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    ForEach(preview.sample) { person in
                        SegmentRuleSampleRow(person: person)
                    }
                }
            } header: {
                Text("Who matches right now")
            } footer: {
                Text(SegmentRuleCopy.previewIsRequired)
            }
        }
    }

    private var nameSection: some View {
        Section {
            TextField("Name this segment", text: $model.name)
                .textInputAutocapitalization(.sentences)
                .disabled(model.isSaving)
        } header: {
            Text("Name")
        } footer: {
            Text("The description saved with it is written from the rules, so it always says what the segment actually does. Your own sentence is kept alongside it as a record of what you asked for.")
        }
    }

    // MARK: - The three outcomes that are not rules

    private func questionsSection(_ questions: [String]) -> some View {
        Section {
            ForEach(Array(questions.enumerated()), id: \.offset) { _, question in
                Label(question, systemImage: "questionmark.circle")
                    .font(.subheadline)
            }
        } header: {
            Text("A question first")
        } footer: {
            Text("\(SegmentRuleCopy.questionHeadline(questions.count)) Add the answer to your sentence and look again. Guessing would give you a segment that is confidently wrong, which is worse than a question.")
        }
    }

    private func unanswerableSection(_ because: String) -> some View {
        Section {
            Label(because, systemImage: "exclamationmark.triangle")
                .font(.subheadline)
        } header: {
            Text("That cannot be answered from what is recorded")
        } footer: {
            Text("Wanting something, liking something, opening a message or clicking a link are not things this system records. Buying, spending, timing and how regularly somebody orders are.")
        }
    }

    private func rejectedSection(_ problems: [SegmentRuleProblem]) -> some View {
        Section {
            if problems.isEmpty {
                Text("The rules that came back were not in a shape this system accepts. Try describing the audience again.")
                    .font(.subheadline)
            } else {
                ForEach(problems) { problem in
                    Label(problem.reason, systemImage: "xmark.octagon")
                        .font(.subheadline)
                }
            }
        } header: {
            Text("Those rules were not accepted")
        } footer: {
            Text("Nothing was saved. Every rule is checked against a fixed list of things a segment can be built from, and anything outside it is refused rather than quietly dropped.")
        }
    }

    // MARK: - Saving

    private func save() {
        guard model.canSave else { return }
        descriptionFocused = false
        Task {
            let created = await model.save()
            if let created {
                listModel.noteSegmentCreated(created)
                await listModel.load(reset: true)
                dismiss()
            }
        }
    }
}

// MARK: - Rows

/// One numbered step in the "how this works" list.
private struct SegmentRuleStep: View {
    let number: Int
    let text: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text("\(number)")
                .font(.caption.weight(.bold))
                .frame(width: 20, height: 20)
                .background(ViciTheme.tint.opacity(0.16), in: Circle())
                .foregroundStyle(ViciTheme.tint)
            Text(text)
                .font(.subheadline)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.vertical, 1)
    }
}

/// One rule, as the sentence the server rendered from it.
///
/// The raw dimension and operator are never shown. "product_order_count" is a
/// database value and the person reading this screen did not choose it.
private struct SegmentRuleConditionRow: View {
    let condition: SegmentRuleCondition
    let plainEnglish: String?
    let isStale: Bool
    let canRemove: Bool
    let edit: () -> Void
    let remove: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                Text(readable)
                    .font(.subheadline)
                    .foregroundStyle(isStale && plainEnglish == nil ? Color.secondary : Color.primary)
                    .fixedSize(horizontal: false, vertical: true)
                if condition.isEditableHere {
                    Text("Tap to change")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 4)
            if condition.isEditableHere {
                Image(systemName: "slider.horizontal.3")
                    .foregroundStyle(ViciTheme.tint)
                    .accessibilityHidden(true)
            }
        }
        .contentShape(Rectangle())
        .onTapGesture { if condition.isEditableHere { edit() } }
        .swipeActions(edge: .trailing) {
            if canRemove {
                Button(role: .destructive) { remove() } label: {
                    Label("Remove", systemImage: "trash")
                }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(readable)
        .accessibilityHint(condition.isEditableHere ? "Double tap to change this rule" : "")
    }

    /// The server's rendering when it is current. After a local edit there is
    /// no current rendering, and saying so is better than showing a sentence
    /// that no longer describes the rule.
    private var readable: String {
        if let plainEnglish, !plainEnglish.isEmpty {
            return plainEnglish.prefix(1).uppercased() + plainEnglish.dropFirst()
        }
        return "Changed. Check who matches again to see this written out."
    }
}

/// One warning about the rules or the count. A wide match is shown as a stop
/// sign rather than a note, because it is the mistake that costs the most.
private struct SegmentRuleWarningRow: View {
    let warning: SegmentRuleProblem

    var body: some View {
        Label {
            Text(warning.reason)
                .font(.footnote)
                .fixedSize(horizontal: false, vertical: true)
        } icon: {
            Image(systemName: warning.isSevere ? "exclamationmark.triangle.fill" : "info.circle")
        }
        .foregroundColor(warning.isSevere ? ViciTheme.warning : Color.secondary)
    }
}

/// One person in the dry run, with the reason they matched.
///
/// The per-condition trace is the thing the research says nobody ships: not
/// "this person is in the segment" but "they ordered BPC-157 three times, and
/// their last order was on 2 May". It is shown here, before saving, because
/// this is the moment a wrong rule is cheapest to notice.
private struct SegmentRuleSampleRow: View {
    let person: SegmentRuleSampleMember
    @State private var isExpanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(person.displayName).font(.subheadline.weight(.medium))
                    Text(PhoneFormatter.pretty(person.contactPhone))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if let trace = person.trace, !trace.isEmpty {
                    Button {
                        isExpanded.toggle()
                    } label: {
                        Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel(isExpanded ? "Hide why they match" : "Show why they match")
                }
            }
            if isExpanded, let trace = person.trace {
                ForEach(trace) { line in
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Image(systemName: line.held ? "checkmark.circle.fill" : "circle")
                            .font(.caption2)
                            .foregroundStyle(line.held ? ViciTheme.tint : Color.secondary)
                        Text(line.sentence)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
        .padding(.vertical, 2)
    }
}

// MARK: - Editing one rule

/// Which rule is being edited. Identified by position, because a condition has
/// no server identity: it is positional inside its rule set.
struct SegmentRuleEditTarget: Identifiable {
    let index: Int
    let condition: SegmentRuleCondition

    var id: Int { index }
}

/// Change the number or the date in one rule.
///
/// Deliberately narrow. An off-by-one on "more than twice" and a wrong month
/// are the corrections that actually happen, and both are one field. Choosing
/// a different product or a different dimension is choosing a different rule,
/// and the honest way to do that is to change the sentence, which is what the
/// footer says.
struct SegmentRuleConditionEditor: View {
    let target: SegmentRuleEditTarget
    let apply: (SegmentRuleCondition) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var singleNumber: Double
    @State private var rangeLow: Double
    @State private var rangeHigh: Double
    @State private var singleDate: Date
    @State private var rangeFrom: Date
    @State private var rangeTo: Date

    init(target: SegmentRuleEditTarget, apply: @escaping (SegmentRuleCondition) -> Void) {
        self.target = target
        self.apply = apply
        let condition = target.condition
        _singleNumber = State(initialValue: condition.singleNumber ?? 0)
        _rangeLow = State(initialValue: condition.numberRange?.low ?? 0)
        _rangeHigh = State(initialValue: condition.numberRange?.high ?? 0)
        let today = Date()
        _singleDate = State(initialValue: condition.singleDate.flatMap(SegmentRuleDate.date(from:)) ?? today)
        _rangeFrom = State(initialValue: condition.dateRange.flatMap { SegmentRuleDate.date(from: $0.from) } ?? today)
        _rangeTo = State(initialValue: condition.dateRange.flatMap { SegmentRuleDate.date(from: $0.to) } ?? today)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    switch target.condition.editKind {
                    case .number:
                        numberField("Value", value: $singleNumber)
                    case .numberRange:
                        numberField("From", value: $rangeLow)
                        numberField("To", value: $rangeHigh)
                    case .date:
                        DatePicker("Date", selection: $singleDate, displayedComponents: .date)
                    case .dateRange:
                        DatePicker("From", selection: $rangeFrom, displayedComponents: .date)
                        DatePicker("To", selection: $rangeTo, displayedComponents: .date)
                    case .notEditable:
                        Text("This rule cannot be changed here.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                } header: {
                    Text("Change this rule")
                } footer: {
                    Text("The wording is written again from the rules once you look at who matches. To use a different product or a different kind of rule, change your sentence instead.")
                }
            }
            .navigationTitle("Edit rule")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        apply(updatedCondition())
                        dismiss()
                    }
                    .disabled(target.condition.editKind == .notEditable)
                }
            }
        }
    }

    /// A stepper for whole-number rules and a decimal field for the rest. The
    /// server refuses a fraction on an order count, so the editor must not be
    /// able to produce one.
    @ViewBuilder
    private func numberField(_ label: String, value: Binding<Double>) -> some View {
        if target.condition.wantsWholeNumbers {
            Stepper(value: value, in: 0...10000, step: 1) {
                LabeledContent(label, value: String(Int(value.wrappedValue.rounded())))
            }
        } else {
            HStack {
                Text(label)
                Spacer()
                TextField(label, value: value, format: .number)
                    .keyboardType(.decimalPad)
                    .multilineTextAlignment(.trailing)
                    .frame(maxWidth: 140)
            }
        }
    }

    private func updatedCondition() -> SegmentRuleCondition {
        switch target.condition.editKind {
        case .number:
            return target.condition.settingNumber(singleNumber)
        case .numberRange:
            return target.condition.settingRange(low: rangeLow, high: rangeHigh)
        case .date:
            return target.condition.settingDate(SegmentRuleDate.text(from: singleDate))
        case .dateRange:
            return target.condition.settingDateRange(from: SegmentRuleDate.text(from: rangeFrom),
                                                     to: SegmentRuleDate.text(from: rangeTo))
        case .notEditable:
            return target.condition
        }
    }
}

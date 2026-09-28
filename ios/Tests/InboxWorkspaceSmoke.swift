import Foundation

@main
struct InboxWorkspaceSmoke {
    static func main() throws {
        let data = Data("""
        [{"phone":"+15550000001","customer_tier":"vip","unread_count":3},
         {"phone":"+15550000002","customer_tier":"standard","unread_count":2},
         {"phone":"+15550000003","unread_count":-1}]
        """.utf8)
        let customers = try JSONDecoder().decode([ConversationSummary].self, from: data)
        precondition(customers.filter(InboxWorkspace.main.includes).count == 2)
        precondition(customers.filter(InboxWorkspace.vip.includes).count == 1)
        precondition(InboxWorkspace.main.unreadCount(in: customers) == 2)
        precondition(InboxWorkspace.vip.unreadCount(in: customers) == 3)
        precondition(InboxWorkspace.destination(for: customers[0]) == .vip)
        precondition(InboxWorkspace.destination(for: customers[1]) == .main)
        precondition(InboxWorkspace(rawValue: "vip") == .vip)
        precondition(InboxWorkspace.storageKey == "vici.inbox.workspace")
        let knownLine = try JSONDecoder().decode(MessageRecord.self, from: Data("""
        {"contact_phone":"+15550000001","direction":"outbound","business_phone":"+15550000099"}
        """.utf8))
        let legacy = try JSONDecoder().decode(MessageRecord.self, from: Data("""
        {"contact_phone":"+15550000001","direction":"outbound"}
        """.utf8))
        precondition(knownLine.businessPhone == "+15550000099")
        precondition(legacy.businessPhone == nil, "Old messages must not invent a business line")
        print("Inbox workspace smoke passed")
    }
}

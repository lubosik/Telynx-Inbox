import Foundation

@main
enum AbandonedCartAnalyticsModelsSmoke {
    static func require(_ condition: @autoclosure () -> Bool, _ message: String) {
        if !condition() {
            FileHandle.standardError.write(Data(("FAILED: " + message + "\n").utf8))
            exit(1)
        }
    }

    static func main() throws {
        let data = Data(#"""
        {
          "generatedAt":"2026-09-15T12:00:00.000Z",
          "range":{"period":"month","start":"2026-09-01T04:00:00.000Z","end":"2026-09-15T12:00:00.000Z","timeZone":"America/New_York","previous":null},
          "metrics":{"recoveredRevenue":"238.00","recoveredOrders":2,"abandonedCarts":10,"recoveryRate":20,"recoveryRateNumerator":2,"recoveryRateDenominator":10,"smsSent":8,"smsDelivered":7,"recoveryLinkClicks":1,"pushSent":4,"pushClicks":1,"voiceEligible":4,"voiceCallsStarted":3,"voiceHumanDetected":1,"voiceMachineDetected":2,"voiceVoicemailsPlayed":2,"voiceTransfersConnected":1,"voiceOptOuts":0,"averageHumanFirstAudioMs":742.5,"discountRecoveries":2,"averageRecoveredOrderValue":119,"currency":"USD","mixedCurrencies":false},
          "funnel":[{"key":"abandoned","label":"Abandoned carts","count":10}],
          "revenueByMethod":[{"method":"sms_recovery_link","revenue":119,"orders":1,"currency":"USD"},{"method":"recovery_coupon","revenue":"119.00","orders":1,"currency":"USD"}],
          "orders":[{
            "id":"record-1","abandonmentEpisodeId":"episode-1","externalCartId":"cart-1","customerName":"Maya","products":["RT"],"abandonedCartValue":"140.00","recoveryMethod":"sms_recovery_link","channel":"sms","messageId":"message-1","pushId":null,"coupon":"VICI15","orderId":"1001","grossRecoveredRevenue":"119.00","discountAmount":"21.00","refundAmount":0,"netRecoveredRevenue":119,"currency":"USD","paidAt":"2026-09-15T11:00:00.000Z","attributionStrength":"direct","conversationOccurred":false,"secondarySignals":{"coupon_used":"VICI15","conversation_occurred":false,"push_clicked":false,"sms_recovery_link_clicked":true}
          }],
          "pagination":{"page":1,"pageSize":25,"total":1,"hasMore":false},
          "warnings":[]
        }
        """#.utf8)
        let report = try JSONDecoder().decode(AbandonedCartAnalyticsOverview.self, from: data)
        require(report.metrics.recoveredRevenue?.value == 238, "net recovered revenue should decode")
        require(report.orders.count == 1, "recovered-order details should decode")
        require(report.orders[0].recoveryMethod == "sms_recovery_link", "primary method should decode")
        require(report.orders[0].secondarySignals.couponUsed == "VICI15", "coupon should remain secondary")
        require(report.metrics.voiceCallsStarted == 3, "voice funnel metrics should decode")
        require(report.metrics.averageHumanFirstAudioMs == 742.5, "voice timing evidence should decode")
        require(AnalyticsPeriod.quarter.title == "This Quarter", "quarter filter should be exposed")
        print("abandoned cart analytics model smoke passed")
    }
}

/** Fixed read-only Cloudflare query shared by statistics and transport policy. */
export const BILLING_METRICS_QUERY = `query getBillingMetrics($AccountID: String!, $filter: AccountWorkersInvocationsAdaptiveFilter_InputObject) {
         viewer { accounts(filter: {accountTag: $AccountID}) {
             workersInvocationsAdaptive(limit: 1000, filter: $filter) { sum { requests } }
             pagesFunctionsInvocationsAdaptiveGroups(limit: 1000, filter: $filter) { sum { requests } }
         }}}`;

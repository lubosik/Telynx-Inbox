'use strict';

const ELIGIBLE_ROLES = new Set(['owner', 'admin']);

/**
 * Prepare, but never dispatch, campaign-review notifications.
 *
 * `canApproveCampaigns` must come from the effective RBAC decision (including
 * user-specific denies), not from a role string alone. The role check prevents
 * legacy/shared or support identities from receiving campaign-ready alerts.
 */
function prepareCampaignReadyNotifications({ users = [], drafts = [], generatedAt = new Date() } = {}) {
  const readyDrafts = drafts.filter(draft => ['draft', 'review_required'].includes(draft?.status));
  if (!readyDrafts.length) return [];

  const workflows = [...new Set(readyDrafts.map(draft => draft.workflowCategory).filter(Boolean))].sort();
  const exactCampaignID = readyDrafts.length === 1 && readyDrafts[0]?.id
    ? String(readyDrafts[0].id)
    : null;
  const generated = generatedAt instanceof Date ? generatedAt : new Date(generatedAt);
  if (!Number.isFinite(generated.getTime())) throw new Error('generatedAt must be a valid date.');

  return users
    .filter(user => user?.isActive === true && ELIGIBLE_ROLES.has(String(user.role || '').toLowerCase()))
    .filter(user => user.canApproveCampaigns === true)
    .map(user => ({
      userID: String(user.id),
      channel: 'native_push_preparation',
      eventType: 'campaigns.ready_for_review',
      collapseID: 'vici-campaigns-ready-for-review',
      payload: {
        aps: {
          alert: {
            title: readyDrafts.length === 1 ? 'Campaign draft ready' : `${readyDrafts.length} campaign drafts ready`,
            body: 'Review the audience, copy, consent coverage and timing before approval.'
          },
          sound: 'default',
          'thread-id': 'vici-campaign-review'
        },
        screen: 'campaigns',
        ...(exactCampaignID ? { campaignID: exactCampaignID, destination: 'review' } : {}),
        reviewCount: readyDrafts.length
      },
      metadata: {
        workflows,
        generatedAt: generated.toISOString()
      }
    }));
}

module.exports = { prepareCampaignReadyNotifications };

'use strict';

function sumUnreadCounts(rows) {
  return (rows || []).reduce((total, row) => {
    const count = Number(row?.unread_count);
    return total + (Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0);
  }, 0);
}

module.exports = { sumUnreadCounts };

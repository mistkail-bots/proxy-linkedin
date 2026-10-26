// Read-only mode rules. Decides whether a request to www.linkedin.com should be blocked.
// Patterns are matched against "path?query" (lowercased) of write requests only (POST/PUT/PATCH/DELETE).
// LinkedIn's internal API names can change, so check the "Write requests" table in the dashboard and
// adjust these patterns if something slips through or something harmless gets blocked.
const WRITE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Never blocked, even in strict mode: sign-in, security checks, analytics/tracking, real-time, messaging.
const ALWAYS_ALLOW = [
  /^\/checkpoint\//, /^\/uas\//, /^\/login/, /^\/authwall/, /^\/li\/track/, /^\/realtime\//, /^\/litms\//,
  /^\/sensorcollect/, /^\/voyager\/api\/(events|voyagermessaging|messaging|voyagernotifications)/,
  /^\/voyager\/api\/graphql\?.*(messenger|messaging|tracking)/,
];

const PATTERNS = {
  // Only profile/account deletion. Removing a saved job, dismissing a suggestion, withdrawing an application etc. stay allowed.
  deletes: /(delete|remove).*(profile|position|education|skill|certification|photo|account)|(profile|position|education|skill|certification|photo|account).*(delete|remove)|close-?account|account-management\/close|hibernate/,
  profileEdits: /\/identity\/(dash\/)?profiles|identitydash(profile|position|education|skill|certification|course|project|honor|language|volunteer|publication|patent|testscore|treasury)|profileedit|editform|profilephoto|profilecover|profilesummary|profileheadline/,
  posting: /contentcreation|\/shares|normshares|ugcposts?|\/posts|\/articles|publishing|\/polls?|sharebox|createpost|reshare|feeddash(share|repost)|\/events\/create|newsletters/,
  engagement: /\/comments|socialactions|\/reactions|\/likes|reactionsummary|commentary/,
};

const LABELS = {
  deletes: 'Delete blocked',
  profileEdits: 'Profile edit blocked',
  posting: 'Post blocked',
  engagement: 'Comment/reaction blocked',
  strict: 'Write blocked (strict mode)',
};

function isWrite(method) {
  return WRITE.has(method.toUpperCase());
}

// Returns null if the request is allowed, otherwise { rule, label }.
function classify(method, urlPath, ro) {
  if (!ro || !ro.enabled || !isWrite(method)) return null;
  const u = urlPath.toLowerCase();
  if (ALWAYS_ALLOW.some((re) => re.test(u))) return null;

  const profileish = /identity|profile|position|education|skill|certification|photo|account/.test(u);
  if (ro.deletes && ((method.toUpperCase() === 'DELETE' && profileish) || PATTERNS.deletes.test(u))) return { rule: 'deletes', label: LABELS.deletes };
  if (ro.profileEdits && PATTERNS.profileEdits.test(u)) return { rule: 'profileEdits', label: LABELS.profileEdits };
  if (ro.posting && PATTERNS.posting.test(u)) return { rule: 'posting', label: LABELS.posting };
  if (ro.engagement && PATTERNS.engagement.test(u)) return { rule: 'engagement', label: LABELS.engagement };
  if (ro.strict) return { rule: 'strict', label: LABELS.strict };
  return null;
}

module.exports = { classify, isWrite, DEFAULTS: { enabled: false, deletes: true, profileEdits: true, posting: true, engagement: false, strict: false } };
